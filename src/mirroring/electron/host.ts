/**
 * Runs mirroring sessions in Electron: per session a hidden capture window (the agent), a utility process (the
 * engine) and a `MessagePort` between them, so frames and encoded chunks never pass through the main process. The
 * Electron objects are handed in, as everywhere in this package.
 *
 * The role this plays in Chrome is `CastMirroringServiceHost` (`chrome/browser/media/cast_mirroring_service_host.cc`),
 * which prepares the capture source (a tab through `WebContentsMediaCaptureId`, the desktop through a stream id) and
 * starts the Mirroring Service, here the engine process.
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { VideoCodec } from "../protocol/constants.ts";
import type { MirroringStats } from "../stats/statistics.ts";
import type { MirroringServiceFactory, MirroringService } from "../mirroring-activity.ts";
import {
  bandwidthBackoffParams, castDesktopMirroringKeepLocalAudio, castStreaming60fps, castStreamingCongestionSignal, castStreamingGradualBandwidthBackoff,
  castStreamingMaxVideoBitrate, castStreamingOfferHardwareFirst, castStreamingPerformanceOverlay,
} from "../../electron/switches.ts";
import { encodingPolicyFromCommandLine, hardwareCodecsToProbe, softwareCodecsToProbe, type CommandLineLike } from "../encoding-support.ts";
import { getCaptureResolutionConstraint, getCodecParameterString, type PrimaryScreenLike } from "../mirror-settings.ts";
import { desktopStreamId, isDesktopSourceWithAudio } from "../routing.ts";
import type { CaptureSource } from "./agent-protocol.ts";
import { AGENT_PRELOAD_SOURCE, AGENT_SOURCE } from "./agent-source.ts";
import type { FromEngine, ToEngine } from "./engine-process.ts";

/** A `MessagePortMain`. */
export interface PortMainLike { postMessage(message: unknown, transfer?: unknown[]): void; start(): void; close(): void }
export interface WebContentsMirrorLike {
  readonly id: number;
  isDestroyed(): boolean;
  isAudioMuted?(): boolean;
  setAudioMuted?(muted: boolean): void;
  /** `webContents.getMediaSourceId(requestWebContents)`: a tab capture id that `requestWebContents` can use once. */
  getMediaSourceId(requestWebContents: unknown): string;
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
  postMessage(channel: string, message: unknown, transfer?: PortMainLike[]): void;
  setWindowOpenHandler(handler: () => { action: "deny" }): void;
  on(event: "will-navigate", listener: (event: { preventDefault(): void }) => void): unknown;
  once(event: "destroyed", listener: () => void): unknown;
  readonly session: {
    setPermissionRequestHandler(handler: ((wc: unknown, permission: string, callback: (granted: boolean) => void) => void) | null): void;
    setPermissionCheckHandler(handler: ((wc: unknown, permission: string) => boolean) | null): void;
    setDisplayMediaRequestHandler(handler: ((request: unknown, callback: (streams: { video?: unknown; audio?: "loopback" | "loopbackWithMute" }) => void) => void) | null): void;
  };
}
export interface BrowserWindowLike {
  readonly webContents: WebContentsMirrorLike;
  loadFile(path: string): Promise<void>;
  destroy(): void;
  isDestroyed(): boolean;
}
export interface UtilityProcessLike {
  postMessage(message: ToEngine, transfer?: PortMainLike[]): void;
  on(event: "message", listener: (message: FromEngine) => void): unknown;
  on(event: "exit", listener: (code: number) => void): unknown;
  on(event: "spawn", listener: () => void): unknown;
  kill(): boolean;
  readonly stdout?: { on(event: "data", listener: (chunk: Buffer) => void): unknown } | null;
  readonly stderr?: { on(event: "data", listener: (chunk: Buffer) => void): unknown } | null;
}

/** The Electron pieces mirroring needs. */
export interface ElectronMirroringApi {
  BrowserWindow: new (options: Record<string, unknown>) => BrowserWindowLike;
  utilityProcess: { fork(modulePath: string, args?: string[], options?: Record<string, unknown>): UtilityProcessLike };
  MessageChannelMain: new () => { port1: PortMainLike; port2: PortMainLike };
  webContents: { fromId(id: number): WebContentsMirrorLike | undefined };
  /**
   * `app`: its `commandLine` is where Chrome's `--cast-streaming-force-{enable,disable}-hardware-<codec>`,
   * `--enable-features` / `--disable-features` (`CastStreamingVp8`, `Vp9`, `Av1`, `HardwareHevc`, `Win/MacHardwareH264`)
   * and `--disable-cast-letterboxing` are read, including switches the app appended itself. Without it only
   * Chrome's defaults apply.
   */
  app?: { commandLine: CommandLineLike };
  /**
   * `screen`: its primary display caps the capture resolution (`CastMirroringServiceHost::GetCaptureResolutionConstraint`,
   * which asks `display::Screen::GetPrimaryDisplay()` for tab and desktop mirroring alike). Without it the capture is
   * limited to 1920x1080, as in Chrome when it cannot get the screen.
   */
  screen?: PrimaryScreenLike;
  /**
   * `systemPreferences`: `getMediaAccessStatus("screen")` is how macOS's Screen Recording permission is read, which Chrome
   * checks before it casts the screen (`MediaRouterUI::CreateRoute`, `ui::IsScreenCaptureAllowed`). Without it the
   * permission is not checked.
   */
  systemPreferences?: { getMediaAccessStatus(mediaType: "screen"): string };
  /**
   * `screen`: its primary display gives the size of the offscreen tab a presentation URL is rendered in
   * (`CastMirroringServiceHost::GetCaptureResolutionConstraint`). Without it the tab is 1920x1080, Chrome's size when it
   * has no screen.
   */
  screen?: { getPrimaryDisplay(): { size: { width: number; height: number }; scaleFactor?: number } };
}

export interface ElectronMirroringOptions {
  electron: ElectronMirroringApi;
  /** Absolute path of the engine entry (`engine-process.js` next to this file in the built package). */
  engineModulePath?: string;
  /** Environment for the session host (`CHROME_MIRRORING_PLAYOUT_DELAY`); default none. */
  env?: Record<string, string | undefined>;
  log?(level: "info" | "error", message: string): void;
}

/** Locates the engine entry beside this module, for both the ESM and the CommonJS build. */
function defaultEngineModulePath(): string {
  const line = (new Error().stack ?? "").split("\n").find((l) => /[\\/]host\.(?:js|cjs|mjs|ts):\d+:\d+/.test(l));
  const match = line === undefined ? null : /(file:\/\/[^\s)]+?|[A-Za-z]:[\\/][^\s)]+?|\/[^\s)]+?)host\.(js|cjs|mjs|ts):\d+:\d+/.exec(line);
  if (match === null) throw new Error("cannot locate the mirroring engine; pass engineModulePath");
  const base = match[1]!.startsWith("file://") ? fileURLToPath(match[1]!) : match[1]!;
  return `${base}engine-process.${match[2] === "ts" ? "ts" : "js"}`;
}

const PORT_CHANNEL = "electron-cast-mirroring:port";
const PAGE = "<!doctype html><meta charset=\"utf-8\"><title>electron-cast capture</title>";

/** Where the encoder is asked about software codecs (`GetCodecParameterString` for 720p at 30 fps). */
const SOFTWARE_PROBE_SIZE = { width: 1280, height: 720 };

/** The `codec_parameter` the offer carries, which is also what the encoder is asked about. */
function probeString(codec: VideoCodec, width: number, height: number, macBaseline: boolean): string {
  const s = getCodecParameterString(codec, width, height, 30, macBaseline ? "baseline" : "main");
  return s === "" ? codec : s;
}

/** `platform` is for tests only: Chrome's choice of desktop loopback device depends on it and is not an app setting. */
export function createElectronMirroringServiceFactory(options: ElectronMirroringOptions, platform: string = process.platform): { factory: MirroringServiceFactory; dispose(): void } {
  const e = options.electron;
  const log = options.log ?? (() => {});
  const live = new Set<() => void>();
  // `GetHardwareCodecDenyList()` is process-wide in Chrome: a hardware encoder that failed in one session is not
  // offered in the next either, for as long as the app runs.
  const hardwareDenyList = new Set<VideoCodec>();

  const factory: MirroringServiceFactory = (params, observer, channel, source): MirroringService => {
    const dir = mkdtempSync(join(tmpdir(), "electron-cast-agent-"));
    let win: BrowserWindowLike | undefined;
    let child: UtilityProcessLike | undefined;
    let ended = false;
    const queue: ToEngine[] = [];
    let ready = false;
    let nextStatsId = 0;
    const pendingStats = new Map<number, (stats: MirroringStats | undefined) => void>();

    let unmuteTab: (() => void) | undefined;
    // The page being mirrored (`CastMirroringServiceHost::web_contents()`), the agent's own page, and whether the
    // start message has been given its capture id yet.
    let tabTarget: WebContentsMirrorLike | undefined;
    let agentContents: WebContentsMirrorLike | undefined;
    let minted = false;
    // CastMirroringServiceHost::CreateAudioStream binds a Muter for the tab's audio group (crbug.com/40708932): the
    // tab is silent locally for the whole session and unmuted when the host goes away. Another feature may have
    // muted the tab first, so only a mute made here is undone.
    const muteTab = (target: WebContentsMirrorLike): void => {
      if (target.setAudioMuted !== undefined && target.isAudioMuted?.() === false) {
        target.setAudioMuted(true);
        unmuteTab = () => {
          if (!target.isDestroyed()) target.setAudioMuted?.(false);
        };
      }
    };
    // CastMirroringServiceHost observes the mirrored WebContents (`Observe(GetContents(...))`, again for the new tab on a
    // switch) and its WebContentsDestroyed() calls StopMirroringSession(): the Mirroring Service is released, whose
    // session host stops and reports DidStop(), and the route ends. A desktop source observes nothing. A stale listener
    // (the tab was switched away from) is ignored, as Chrome stops observing the old contents.
    const observeTab = (target: WebContentsMirrorLike): void => {
      target.once("destroyed", () => {
        if (ended || tabTarget !== target) return;
        observer.didStop?.();
        teardown();
      });
    };
    const teardown = (): void => {
      if (ended) return;
      ended = true;
      for (const resolve of pendingStats.values()) resolve(undefined);
      pendingStats.clear();
      unmuteTab?.();
      live.delete(teardown);
      try {
        child?.postMessage({ type: "stop" });
      } catch {
        // already gone
      }
      const c = child;
      if (c !== undefined) setTimeout(() => c.kill(), 1000).unref();
      if (win !== undefined && !win.isDestroyed()) win.destroy();
      rmSync(dir, { recursive: true, force: true });
    };
    live.add(teardown);

    const post = (message: ToEngine): void => {
      if (ready && child !== undefined) child.postMessage(message);
      else queue.push(message);
    };

    void (async () => {
      try {
        writeFileSync(join(dir, "preload.cjs"), AGENT_PRELOAD_SOURCE, { mode: 0o600 });
        writeFileSync(join(dir, "agent.html"), PAGE, { mode: 0o600 });
        win = new e.BrowserWindow({
          show: false,
          width: 320,
          height: 240,
          webPreferences: {
            preload: join(dir, "preload.cjs"),
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
            webSecurity: true,
            // A private, in-memory partition: nothing of the app's own session is shared with the capture window.
            partition: `electron-cast-mirroring-${randomUUID()}`,
            backgroundThrottling: false,
          },
        });
        const wc = win.webContents;
        agentContents = wc;
        wc.setWindowOpenHandler(() => ({ action: "deny" }));
        wc.on("will-navigate", (ev) => ev.preventDefault());
        wc.session.setPermissionRequestHandler((_wc, permission, callback) => callback(permission === "media" || permission === "display-capture"));
        wc.session.setPermissionCheckHandler((_wc, permission) => permission === "media" || permission === "display-capture");

        let capture: CaptureSource;
        let mintTabSource: (() => CaptureSource) | undefined;
        // An offscreen tab is captured as a tab is: `OpenOffscreenTab` sets `source_media_id_` to
        // `BuildMediaIdForWebContents(offscreen_tab_->web_contents())` and observes those contents.
        if (source.type !== "desktop") {
          const tabId = source.tabId ?? Number(source.id.slice(source.id.lastIndexOf(":") + 1));
          const target = e.webContents.fromId(tabId);
          if (target === undefined || target.isDestroyed()) throw new Error(`no page with webContents id ${tabId}`);
          tabTarget = target;
          observeTab(target);
          // The id is bound to the requesting frame, so it can only be minted once the agent page has loaded. A switch
          // that came in before then has replaced `tabTarget`, so the start carries the newest tab.
          mintTabSource = () => ({ kind: "tab", mediaSourceId: tabTarget!.getMediaSourceId(wc) });
          muteTab(target);
          capture = { kind: "tab", mediaSourceId: "" };
        } else {
          const id = desktopStreamId(source.id) ?? "";
          // CastMirroringServiceHost parses the media id it is given (DesktopMediaID::Parse) and captures it; it does not
          // list the sources again. Listing them here failed on Linux (X11 under Xvfb), where the screen the app had
          // just been given was not in a second list; an id that names nothing fails the capture instead. Electron's
          // handler also wants a name, which only labels the track.
          const chosen = { id, name: id };
          const withAudio = isDesktopSourceWithAudio(source.id);
          // CastMirroringServiceHost::GetDesktopAudioLoopbackDeviceId: Windows keeps local playback
          // (kLoopbackInputDeviceId; kCastDesktopMirroringKeepLocalAudio is on by default there, as muting the endpoint
          // silences the loopback on some drivers, and --disable-features=CastDesktopMirroringKeepLocalAudio turns it off);
          // every other platform mutes it (kLoopbackWithMuteDeviceId).
          const audioMode = platform === "win32" && castDesktopMirroringKeepLocalAudio(e.app?.commandLine) ? "loopback" : "loopbackWithMute";
          wc.session.setDisplayMediaRequestHandler((_request, callback) => callback(withAudio ? { video: chosen, audio: audioMode } : { video: chosen }));
          capture = { kind: "desktop", sourceId: id, audio: audioMode };
        }

        await win.loadFile(join(dir, "agent.html"));
        if (mintTabSource !== undefined) {
          capture = mintTabSource();
          minted = true;
        }
        // Feature-detect what WebCodecs can encode here. Chrome asks the GPU process for the hardware encoder profiles
        // (`encoding_support::IsHardwareEnabled`); `prefer-hardware` is the same question: Chromium's VideoEncoder then
        // accepts the configuration only if a hardware encoder takes it (blink video_encoder.cc: `GetRequiredEncoderType`
        // is `kHardware`, and `CreateMediaVideoEncoder` returns the accelerated encoder's status without a software
        // fallback). Hardware is asked about at the session's maximum resolution, as Chrome does; software, VP8 first and
        // anything else only when asked for, as before.
        const macBaseline = platform === "darwin";
        // CastMirroringServiceHost::Start passes GetCaptureResolutionConstraint() to the Mirroring Service, once per session.
        const maxResolution = getCaptureResolutionConstraint(e.screen);
        const probes: { codec: VideoCodec; hardware: boolean; string: string; width: number; height: number }[] = [];
        // Read at every session, as Chrome reads its command line and features whenever it negotiates.
        const policy = encodingPolicyFromCommandLine(e.app?.commandLine, platform);
        for (const codec of hardwareCodecsToProbe(policy)) {
          probes.push({ codec, hardware: true, string: probeString(codec, maxResolution.width, maxResolution.height, macBaseline), width: maxResolution.width, height: maxResolution.height });
        }
        for (const codec of softwareCodecsToProbe(policy)) {
          probes.push({ codec, hardware: false, string: probeString(codec, SOFTWARE_PROBE_SIZE.width, SOFTWARE_PROBE_SIZE.height, macBaseline), ...SOFTWARE_PROBE_SIZE });
        }
        const found = (await wc.executeJavaScript(
          `(async () => { const out = []; for (const p of ${JSON.stringify(probes)}) {` +
            ` try { const config = { codec: p.string, width: p.width, height: p.height, bitrate: 2000000, framerate: 30, latencyMode: "realtime", hardwareAcceleration: p.hardware ? "prefer-hardware" : "prefer-software" };` +
            ` if (p.codec === "h264") config.avc = { format: "annexb" }; if (p.codec === "hevc") config.hevc = { format: "annexb" };` +
            ` const r = await VideoEncoder.isConfigSupported(config);` +
            ` if (r.supported) out.push({ codec: p.codec, hardware: p.hardware }); } catch {} } return out; })()`,
        )) as { codec: VideoCodec; hardware: boolean }[];
        const hardwareCodecs = found.filter((f) => f.hardware).map((f) => f.codec);
        const softwareCodecs = found.filter((f) => !f.hardware).map((f) => f.codec);
        if (!softwareCodecs.includes("vp8")) throw new Error("this Electron's WebCodecs cannot encode VP8");
        log("info", `encoders: hardware [${hardwareCodecs.join(", ")}], software [${softwareCodecs.join(", ")}]${hardwareDenyList.size > 0 ? `, deny-listed hardware [${[...hardwareDenyList].join(", ")}]` : ""}`);
        await wc.executeJavaScript(AGENT_SOURCE);

        const channelMain = new e.MessageChannelMain();
        wc.postMessage(PORT_CHANNEL, null, [channelMain.port1]);
        const enginePath = options.engineModulePath ?? defaultEngineModulePath();
        const proc = e.utilityProcess.fork(enginePath, [], { serviceName: "electron-cast mirroring", stdio: "pipe" });
        child = proc;
        // The engine's own output (an exception, say) goes to the log, not to the app's console.
        proc.stdout?.on("data", (c) => log("info", `engine: ${c.toString().trimEnd()}`));
        proc.stderr?.on("data", (c) => log("error", `engine: ${c.toString().trimEnd()}`));
        proc.on("message", (m) => {
          switch (m.type) {
            case "send": channel.send(m.namespace, m.json); break;
            case "did-start": observer.didStart?.(); break;
            // MirroringActivity::OnError and ::DidStop both end in StopMirroring, which stops this service; ending it
            // here too keeps the window and the process from outliving a session whose owner did not.
            case "did-stop": observer.didStop?.(); teardown(); break;
            case "error": observer.onError?.(m.error as never, m.message); teardown(); break;
            case "log": observer.logInfo?.(m.message); break;
            case "stats": pendingStats.get(m.id)?.(m.stats); pendingStats.delete(m.id); break;
            case "deny-hardware-codec": hardwareDenyList.add(m.codec); break;
          }
        });
        proc.on("exit", (code) => {
          if (!ended) {
            observer.onError?.("CAST_TRANSPORT_ERROR", `the mirroring engine exited (${code})`);
            teardown();
          }
        });
        proc.postMessage(
          {
            type: "start", params, source: capture, hardwareCodecs, softwareCodecs, hardwareDenyList: [...hardwareDenyList],
            encodingPolicy: {
              hardwareFeatures: [...policy.hardwareFeatures], softwareFeatures: [...policy.softwareFeatures],
              forceEnable: [...policy.forceEnable], forceDisable: [...policy.forceDisable],
            },
            env: options.env,
            maxResolution,
            // Features are read at every session, like the encoding policy.
            features: {
              congestionSignal: castStreamingCongestionSignal(e.app?.commandLine, (message) => log("info", message)),
              performanceOverlay: castStreamingPerformanceOverlay(e.app?.commandLine),
              enable60fps: castStreaming60fps(e.app?.commandLine),
              maxVideoBitrate: castStreamingMaxVideoBitrate(e.app?.commandLine, (message) => log("info", message)),
              bandwidthBackoff: bandwidthBackoffParams(e.app?.commandLine, (message) => log("info", message)),
              gradualBandwidthBackoff: castStreamingGradualBandwidthBackoff(e.app?.commandLine),
              offerHardwareFirst: castStreamingOfferHardwareFirst(e.app?.commandLine),
            },
          },
          [channelMain.port2],
        );
        ready = true;
        for (const m of queue.splice(0)) proc.postMessage(m);
      } catch (err) {
        log("error", `mirroring could not start: ${err instanceof Error ? err.message : String(err)}`);
        observer.onError?.("VIDEO_CAPTURE_ERROR", err instanceof Error ? err.message : String(err));
        teardown();
      }
    })();

    return {
      onMessage: (namespace, json) => post({ type: "message", namespace, json }),
      // CastMirroringServiceHost::SwitchMirroringSourceTab: the host starts observing the new tab, drops the old tab's
      // Muter (the audio stream, created again, binds one for the new tab), and tells the Mirroring Service, which
      // moves its video capture client and audio input device to the new source without renegotiating.
      switchMirroringSourceTab: (webContentsId) => {
        if (ended) throw new Error("the mirroring session has ended");
        if (source.type !== "tab" || tabTarget === undefined) throw new Error("only a tab can be switched");
        const next = e.webContents.fromId(webContentsId);
        if (next === undefined || next.isDestroyed()) throw new Error(`no page with webContents id ${webContentsId}`);
        // Minted first, so a page that cannot be captured leaves the session as it was.
        const capture: CaptureSource | undefined = minted ? { kind: "tab", mediaSourceId: next.getMediaSourceId(agentContents) } : undefined;
        unmuteTab?.();
        unmuteTab = undefined;
        muteTab(next);
        tabTarget = next;
        observeTab(next);
        if (capture !== undefined) post({ type: "switch-source", webContentsId, source: capture });
      },
      // CastMirroringServiceHost::Pause / Resume: straight to the video capture host, so audio goes on.
      pause: (onPaused) => {
        if (ended) return;
        post({ type: "pause" });
        onPaused();
      },
      resume: (onResumed) => {
        if (ended) return;
        post({ type: "resume" });
        onResumed();
      },
      getMirroringStats: () => {
        if (ended) return Promise.resolve(undefined);
        const id = nextStatsId++;
        return new Promise<MirroringStats | undefined>((resolve) => {
          pendingStats.set(id, resolve);
          post({ type: "get-stats", id });
        });
      },
      stop: teardown,
    };
  };

  return {
    factory,
    dispose() {
      for (const t of [...live]) t();
    },
  };
}
