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
  desktopCapturer: { getSources(options: { types: string[] }): Promise<{ id: string; name: string }[]> };
  webContents: { fromId(id: number): WebContentsMirrorLike | undefined };
}

export interface ElectronMirroringOptions {
  electron: ElectronMirroringApi;
  /**
   * Video codecs the sender may offer when WebCodecs can encode them, in addition to VP8 (always). Chrome's software
   * list is VP8 and VP9 (`encoding_support.cc`); default none, so a stream is VP8 unless you opt in.
   */
  extraVideoCodecs?: ("vp9")[];
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

/** Codec strings probed in the agent window (`GetCodecParameterString` for 720p at 30 fps). */
const PROBE: Record<string, string> = { vp8: "vp8", vp9: "vp09.00.40.08" };

/** `platform` is for tests only: Chrome's choice of desktop loopback device depends on it and is not an app setting. */
export function createElectronMirroringServiceFactory(options: ElectronMirroringOptions, platform: string = process.platform): { factory: MirroringServiceFactory; dispose(): void } {
  const e = options.electron;
  const log = options.log ?? (() => {});
  const live = new Set<() => void>();

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
        if (source.type === "tab") {
          const tabId = Number(source.id.slice(source.id.lastIndexOf(":") + 1));
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
          const sources = await e.desktopCapturer.getSources({ types: ["screen", "window"] });
          const chosen = sources.find((s) => s.id === id);
          if (chosen === undefined) throw new Error(`no desktop source ${id}`);
          const withAudio = isDesktopSourceWithAudio(source.id);
          // CastMirroringServiceHost::GetDesktopAudioLoopbackDeviceId: Windows keeps local playback
          // (kLoopbackInputDeviceId, kCastDesktopMirroringKeepLocalAudio is on by default there, as muting the endpoint
          // silences the loopback on some drivers); every other platform mutes it (kLoopbackWithMuteDeviceId).
          const audioMode = platform === "win32" ? "loopback" : "loopbackWithMute";
          wc.session.setDisplayMediaRequestHandler((_request, callback) => callback(withAudio ? { video: chosen, audio: audioMode } : { video: chosen }));
          capture = { kind: "desktop", sourceId: id, audio: audioMode };
        }

        await win.loadFile(join(dir, "agent.html"));
        if (mintTabSource !== undefined) {
          capture = mintTabSource();
          minted = true;
        }
        // Feature-detect what WebCodecs can encode here; VP8 first, anything else only when asked for.
        const supported = (await wc.executeJavaScript(
          `(async () => { const out = []; for (const [name, codec] of Object.entries(${JSON.stringify(PROBE)})) {` +
            ` try { const r = await VideoEncoder.isConfigSupported({ codec, width: 1280, height: 720, bitrate: 2000000, framerate: 30, latencyMode: "realtime" });` +
            ` if (r.supported) out.push(name); } catch {} } return out; })()`,
        )) as string[];
        if (!supported.includes("vp8")) throw new Error("this Electron's WebCodecs cannot encode VP8");
        const softwareCodecs: VideoCodec[] = ["vp8"];
        for (const extra of options.extraVideoCodecs ?? []) if (supported.includes(extra)) softwareCodecs.push(extra);
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
          }
        });
        proc.on("exit", (code) => {
          if (!ended) {
            observer.onError?.("CAST_TRANSPORT_ERROR", `the mirroring engine exited (${code})`);
            teardown();
          }
        });
        proc.postMessage({ type: "start", params, source: capture, softwareCodecs, env: options.env }, [channelMain.port2]);
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
