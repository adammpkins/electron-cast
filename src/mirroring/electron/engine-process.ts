/**
 * The mirroring engine as an Electron `utilityProcess` entry: one process per mirroring route, so pacing, RTCP and
 * encryption never wait for the main process (and a stuck page cannot stall a stream). Its parent is the main
 * process, which relays Cast messages; the capture agent in the hidden window is reached over a port it was handed.
 *
 *   main --{start, ports:[agent]}--> engine --{send, observer}--> main
 *   main --{message}--> engine
 */
import { createEncodingSupport } from "../encoding-support.ts";
import { createMirroringServiceFactory } from "../engine.ts";
import type { MirroringService } from "../mirroring-activity.ts";
import type { MirroringFeatures, SessionParameters } from "../session-host.ts";
import type { MirroringStats } from "../stats/statistics.ts";
import type { VideoCodec } from "../protocol/constants.ts";
import type { AgentPort, AgentToEngine, CaptureSource, EngineToAgent } from "./agent-protocol.ts";
import { PortBackend } from "./port-backend.ts";

/** Main to engine. */
export type ToEngine =
  | {
      type: "start";
      params: SessionParameters;
      source: CaptureSource;
      /** What `VideoEncoder.isConfigSupported` found: `prefer-hardware` and `prefer-software` respectively. */
      hardwareCodecs: VideoCodec[];
      softwareCodecs: VideoCodec[];
      /** Codecs whose hardware encoder failed earlier in the app's run (`GetHardwareCodecDenyList`). */
      hardwareDenyList: VideoCodec[];
      /** Chrome's codec switches and features as the app's command line sets them. */
      encodingPolicy: { hardwareFeatures: VideoCodec[]; softwareFeatures: VideoCodec[]; forceEnable: VideoCodec[]; forceDisable: VideoCodec[] };
      env?: Record<string, string | undefined>;
      /** `CastMirroringServiceHost::GetCaptureResolutionConstraint()`. */
      maxResolution?: { width: number; height: number };
      /** The Chrome features read from the app's command line (`mirroring_features.cc`, `media_switches.cc`). */
      features?: MirroringFeatures;
    }
  | { type: "message"; namespace: string; json: string }
  /** `SwitchMirroringSourceTab`: `source` is the new tab's capture id. */
  | { type: "switch-source"; webContentsId: number; source: CaptureSource }
  /** `CastMirroringServiceHost::Pause` / `Resume`. */
  | { type: "pause" }
  | { type: "resume" }
  | { type: "get-stats"; id: number }
  | { type: "stop" };

/** Engine to main. */
export type FromEngine =
  | { type: "send"; namespace: string; json: string }
  | { type: "did-start" }
  | { type: "did-stop" }
  | { type: "error"; error: string; message: string }
  | { type: "log"; message: string }
  | { type: "stats"; id: number; stats: MirroringStats | undefined }
  /** A hardware encoder failed and the codec is no longer offered in hardware: the main process keeps the list. */
  | { type: "deny-hardware-codec"; codec: VideoCodec };

/** The slice of `process.parentPort` and of a `MessagePortMain` this file uses. */
export interface ParentPortLike {
  postMessage(message: FromEngine): void;
  on(event: "message", listener: (event: { data: ToEngine; ports: MessagePortLike[] }) => void): unknown;
}
export interface MessagePortLike {
  postMessage(message: unknown, transfer?: unknown[]): void;
  on(event: "message", listener: (event: { data: unknown }) => void): unknown;
  start(): void;
  close(): void;
}

function agentPortFrom(port: MessagePortLike): AgentPort {
  return {
    postMessage: (message: EngineToAgent) => port.postMessage(message),
    onMessage: (listener) => {
      port.on("message", (e) => listener(e.data as AgentToEngine));
      port.start();
    },
    close: () => port.close(),
  };
}

export function runEngineProcess(parentPort: ParentPortLike, exit: () => void = () => process.exit(0)): void {
  let service: MirroringService | undefined;
  let backend: PortBackend | undefined;
  parentPort.on("message", ({ data, ports }) => {
    if (data.type === "start") {
      const agent = ports[0];
      if (agent === undefined || service !== undefined) return;
      const source = data.source;
      const factory = createMirroringServiceFactory({
        createBackend: () => (backend = new PortBackend(agentPortFrom(agent), source)),
        encodingSupport: createEncodingSupport(
          { hardware: new Set(data.hardwareCodecs), software: new Set(data.softwareCodecs) },
          {
            denyListed: new Set(data.hardwareDenyList),
            onDenyListed: (codec) => parentPort.postMessage({ type: "deny-hardware-codec", codec }),
            policy: {
              hardwareFeatures: new Set(data.encodingPolicy.hardwareFeatures), softwareFeatures: new Set(data.encodingPolicy.softwareFeatures),
              forceEnable: new Set(data.encodingPolicy.forceEnable), forceDisable: new Set(data.encodingPolicy.forceDisable),
            },
          },
        ),
        env: data.env,
        maxResolution: data.maxResolution,
        features: data.features,
      });
      service = factory(
        data.params,
        {
          didStart: () => parentPort.postMessage({ type: "did-start" }),
          didStop: () => parentPort.postMessage({ type: "did-stop" }),
          onError: (error, message) => parentPort.postMessage({ type: "error", error, message }),
          logInfo: (message) => parentPort.postMessage({ type: "log", message }),
        },
        { send: (namespace, json) => parentPort.postMessage({ type: "send", namespace, json }) },
      );
    } else if (data.type === "message") {
      service?.onMessage(data.namespace, data.json);
    } else if (data.type === "switch-source") {
      backend?.setSource(data.source);
      service?.switchMirroringSourceTab?.(data.webContentsId);
    } else if (data.type === "pause") {
      service?.pause?.(() => {});
    } else if (data.type === "resume") {
      service?.resume?.(() => {});
    } else if (data.type === "get-stats") {
      const id = data.id;
      void (service?.getMirroringStats?.() ?? Promise.resolve(undefined)).then((stats) => parentPort.postMessage({ type: "stats", id, stats }));
    } else if (data.type === "stop") {
      service?.stop();
      service = undefined;
      exit();
    }
  });
}

// Started by `utilityProcess.fork`; imported by tests, where there is no parent port.
const parentPort = (process as unknown as { parentPort?: ParentPortLike }).parentPort;
if (parentPort !== undefined) runEngineProcess(parentPort);
