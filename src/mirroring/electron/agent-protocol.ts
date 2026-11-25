/**
 * Messages between the engine (a utility process) and the capture agent (a hidden renderer), over a `MessagePort`.
 * The engine decides, the agent captures and encodes: this is the split Chrome has between the Mirroring Service
 * (`OpenscreenSessionHost`, which decides whether a frame is dropped) and the capture and encode resources it is
 * given (`mojom::ResourceProvider`: `VideoCaptureHost`, `AudioInputDevice`, the encoder).
 *
 * Times are epoch milliseconds (`performance.timeOrigin + performance.now()`), the one clock both sides can read.
 */

/** What to capture. */
export type CaptureSource =
  | { kind: "tab"; /** `webContents.getMediaSourceId(agent)` of the mirrored page. */ mediaSourceId: string }
  | {
      kind: "desktop";
      /** The `desktopCapturer` source id the app chose. */
      sourceId: string;
      /**
       * `loopback` captures system audio and leaves local playback alone (Windows, `kLoopbackInputDeviceId`); it goes
       * through `getUserMedia`. `loopbackWithMute` also mutes local playback while mirroring
       * (`kLoopbackWithMuteDeviceId`, every other platform) and needs `getDisplayMedia`, answered by the host's handler.
       */
      audio: "loopback" | "loopbackWithMute";
    };

export interface AgentStartMessage {
  t: "start";
  source: CaptureSource;
  video?: { width: number; height: number; frameRate: number };
  audio?: { sampleRate: number; channels: number };
}

export type EngineToAgent =
  | AgentStartMessage
  | { t: "encode"; rtp: number }
  | { t: "set-bitrate"; bps: number }
  | { t: "set-codec"; codec: "vp8" | "vp9" | "h264" | "av1"; codecString: string }
  | { t: "key-frame" }
  | { t: "pause" }
  | { t: "resume" }
  | { t: "refresh" }
  | { t: "encode-audio"; seq: number }
  | { t: "drop-audio"; seq: number }
  | { t: "set-audio"; bps: number }
  | { t: "stop" };

export type AgentToEngine =
  | { t: "ready" }
  | { t: "error"; where: "video" | "audio" | "encoder"; message: string }
  | { t: "frame"; rtp: number; refMs: number; width: number; height: number }
  | { t: "video-chunk"; rtp: number; key: boolean; data: ArrayBuffer; encodeMs: number }
  /** The frame never produced a chunk (encoder queue full, evicted, unsupported, or swallowed by the encoder). */
  | { t: "video-drop"; rtp: number }
  | { t: "audio-drop"; seq: number }
  | { t: "audio-buffer"; seq: number; frames: number; recMs: number }
  | { t: "audio-chunk"; seq: number; data: ArrayBuffer }
  | { t: "encoder-status"; kind: "video" | "audio"; status: "initialized" | "unsupported_codec" | "codec_init_failed" | "codec_runtime_error" };

/** The slice of Electron's `MessagePortMain` the engine side uses. */
export interface AgentPort {
  postMessage(message: EngineToAgent): void;
  onMessage(listener: (message: AgentToEngine) => void): void;
  close(): void;
}
