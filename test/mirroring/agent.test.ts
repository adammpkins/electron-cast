import { test } from "node:test";
import assert from "node:assert/strict";
import { createContext, runInContext } from "node:vm";
import { AGENT_SOURCE } from "../../src/mirroring/electron/agent-source.ts";
import { PortBackend, UNDERRUN_SKIP_THRESHOLD } from "../../src/mirroring/electron/port-backend.ts";
import type { AgentPort, AgentToEngine, EngineToAgent } from "../../src/mirroring/electron/agent-protocol.ts";

/**
 * agent-source.ts runs in a renderer, so it is evaluated here in a vm context with stand-ins for the WebCodecs and
 * capture APIs it uses. The stand-in encoder only emits what the test tells it to, which is how the dropped and
 * reordered outputs a real encoder can produce are simulated.
 */

interface FakeFrame {
  metadata?: () => { captureTime?: number };
  timestamp: number; displayWidth: number; displayHeight: number; closed: boolean; close(): void; clone(): FakeFrame;
  format?: string; visibleRect?: { width: number; height: number }; duration?: number | null;
  allocationSize?(): number; copyTo?(destination: Uint8Array): Promise<{ offset: number; stride: number }[]>;
}
interface FrameOptions {
  /** How long after the previous capture this one arrives (default 33 ms); `captureTime` is its metadata capture time. */
  gapMs?: number; captureTime?: number;
  width?: number; height?: number; format?: string; duration?: number | null; luma?: (x: number, y: number) => number }
const frame = (timestamp: number, o: FrameOptions = {}): FakeFrame => {
  const width = o.width ?? 640, height = o.height ?? 360;
  const f: FakeFrame = {
    timestamp, displayWidth: width, displayHeight: height, closed: false,
    close() { this.closed = true; },
    clone() { return frame(this.timestamp, o); },
  };
  if (o.luma !== undefined || o.format !== undefined) {
    // A planar 4:2:0 frame: the luma plane first, tightly packed, then the chroma planes.
    f.format = o.format ?? "I420";
    f.visibleRect = { width, height };
    f.duration = o.duration;
    f.allocationSize = () => width * height * 3 / 2;
    f.copyTo = async (destination) => {
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) destination[y * width + x] = o.luma?.(x, y) ?? 0;
      return [{ offset: 0, stride: width }, { offset: width * height, stride: width / 2 }, { offset: width * height * 5 / 4, stride: width / 2 }];
    };
  } else if (o.duration !== undefined) {
    f.duration = o.duration;
  }
  return f;
};

function startAgent() {
  const sent: AgentToEngine[] = [];
  const port = { postMessage: (m: AgentToEngine) => void sent.push(m), start() {}, onmessage: undefined as ((e: { data: unknown }) => void) | undefined };
  let listener: ((e: { data: unknown; ports: unknown[] }) => void) | undefined;
  let now = 1000;
  const encoders: FakeEncoder[] = [];
  // One queue per captured track: a switched tab has its own track, and a stopped track ends its stream of frames.
  interface FakeTrack { stopped: boolean; stop(): void; queued: FakeFrame[]; waiters: ((r: { value?: FakeFrame; done: boolean }) => void)[] }
  const tracks: FakeTrack[] = [];
  const refuse = { next: false };
  const requests: { video?: { mandatory?: Record<string, unknown> } }[] = [];
  const makeTrack = (): FakeTrack => {
    const t: FakeTrack = { stopped: false, queued: [], waiters: [], stop() { t.stopped = true; for (const w of t.waiters.splice(0)) w({ done: true }); } };
    tracks.push(t);
    return t;
  };
  const supportChecks: Record<string, unknown>[] = [];
  const userMedia: Record<string, unknown>[] = [];
  const displayMedia: Record<string, unknown>[] = [];
  const control = { supported: (_config: Record<string, unknown>) => true };

  class FakeEncoder {
    static async isConfigSupported(config: Record<string, unknown>) { supportChecks.push(config); return { supported: control.supported(config) }; }
    configures: Record<string, unknown>[] = [];
    encodes: { frame: FakeFrame; keyFrame: boolean }[] = [];
    encodeQueueSize = 0;
    state = "unconfigured";
    init: { output(chunk: unknown): void; error(e: unknown): void };
    constructor(init: { output(chunk: unknown): void; error(e: unknown): void }) { this.init = init; encoders.push(this); }
    configure(config: Record<string, unknown>) { this.configures.push(config); this.state = "configured"; }
    encode(f: FakeFrame, options: { keyFrame: boolean }) { this.encodes.push({ frame: f, keyFrame: options.keyFrame }); }
    close() { this.state = "closed"; }
    emit(index: number, key = false) {
      const e = this.encodes[index]!;
      this.init.output({ type: key ? "key" : "delta", timestamp: e.frame.timestamp, byteLength: 4, copyTo: (b: ArrayBuffer) => new Uint8Array(b).set([1, 2, 3, 4]) });
    }
  }

  const context = createContext({
    window: { addEventListener: (_: string, l: typeof listener) => { listener = l; } },
    performance: { timeOrigin: 0, now: () => now },
    navigator: { mediaDevices: {
      getDisplayMedia: async (constraints: Record<string, unknown>) => {
        displayMedia.push(constraints);
        const v = makeTrack(), au = makeTrack();
        tracks.splice(tracks.indexOf(au), 1);
        return { getVideoTracks: () => [v], getAudioTracks: () => [au], getTracks: () => [v, au] };
      },
      getUserMedia: async (constraints: (typeof requests)[number]) => { requests.push(constraints); userMedia.push(constraints as Record<string, unknown>); if (refuse.next) { refuse.next = false; throw new Error("denied"); } const track = makeTrack(); return { getVideoTracks: () => [track], getAudioTracks: () => [], getTracks: () => [track] }; } } },
    MediaStreamTrackProcessor: class {
      readable: { getReader(): { read(): Promise<{ value?: FakeFrame; done: boolean }> } };
      constructor({ track }: { track: FakeTrack }) {
        this.readable = { getReader: () => ({ read: () => track.stopped ? Promise.resolve({ done: true }) : track.queued.length > 0 ? Promise.resolve({ value: track.queued.shift(), done: false }) : new Promise((r) => track.waiters.push(r)) }) };
      }
    },
    VideoEncoder: FakeEncoder,
    AudioEncoder: class { static async isConfigSupported() { return { supported: true }; } state = "configured"; configure() {} encode() {} close() {} },
    ArrayBuffer, Uint8Array, Float32Array, Map, String, Math, Promise,
  });
  runInContext(AGENT_SOURCE, context);
  listener!({ data: "electron-cast-mirroring:port", ports: [port] });

  const settle = () => new Promise((r) => setTimeout(r, 5));
  return {
    sent, encoders, settle, tracks, requests, refuse, supportChecks, userMedia, displayMedia, control,
    advance: (ms: number) => { now += ms; },
    command: async (m: EngineToAgent) => { await (port.onmessage as (e: { data: unknown }) => Promise<void>)({ data: m }); await settle(); },
    capture: async (ts: number, options: FrameOptions = {}) => {
      now += options.gapMs ?? 33;
      const f = frame(ts, options);
      if (options.captureTime !== undefined) { const captureTime = options.captureTime; f.metadata = () => ({ captureTime }); }
      const track = tracks.at(-1)!;
      const w = track.waiters.shift();
      if (w) w({ value: f, done: false }); else track.queued.push(f);
      await settle();
    },
    rtps: () => sent.filter((m) => m.t === "frame").map((m) => (m as { rtp: number }).rtp),
  };
}

test("agent: desktop audio that mutes local playback comes from getDisplayMedia, with no minimum size; the video keeps the session's policy", async () => {
  const a = startAgent();
  await a.command({
    t: "start", source: { kind: "desktop", sourceId: "screen:1:0", audio: "loopbackWithMute" },
    video: { width: 1920, height: 1080, frameRate: 30, resolutionChangePolicy: "fixed_aspect_ratio" }, audio: { sampleRate: 48000, channels: 2 },
  });
  assert.deepEqual(a.sent.filter((m) => m.t === "error"), []);
  // Blink refuses min (and exact) constraints in getDisplayMedia with a TypeError.
  assert.deepEqual(JSON.parse(JSON.stringify(a.displayMedia)), [{ audio: true, video: { frameRate: { max: 30 }, width: { max: 1920 }, height: { max: 1080 } } }]);
  assert.equal(a.userMedia.length, 1);
  const video = (a.userMedia[0] as { audio: unknown; video: { mandatory: Record<string, number | string> } });
  assert.equal(video.audio, false);
  assert.equal(video.video.mandatory.chromeMediaSource, "desktop");
  assert.equal(video.video.mandatory.chromeMediaSourceId, "screen:1:0");
  assert.equal(blinkPolicy(video.video.mandatory as Record<string, number>), "fixed_aspect_ratio");
  // getDisplayMedia's own video track is stopped; the frames come from the getUserMedia track.
  assert.equal(a.tracks[0]!.stopped, true);
  await a.capture(0, { width: 1920, height: 1080 });
  assert.equal(a.rtps().length, 1);
});

test("agent: repeated bitrate changes reconfigure in place, force no key frame, and keep chunks paired with their frames", async () => {
  const a = startAgent();
  await a.command({ t: "start", source: { kind: "tab", mediaSourceId: "x" }, video: { width: 640, height: 360, frameRate: 30, resolutionChangePolicy: "fixed_resolution" } });
  for (let i = 0; i < 6; i++) {
    await a.capture(i * 33_000);
    await a.command({ t: "encode", rtp: a.rtps()[i]! });
    await a.command({ t: "set-bitrate", bps: 1_000_000 + i * 250_000 });
  }
  const rtps = a.rtps();
  assert.equal(rtps.length, 6);
  assert.equal(a.encoders.length, 1, "one encoder for the whole stream");
  const enc = a.encoders[0]!;
  assert.deepEqual(enc.configures.map((c) => c.bitrate).slice(-3), [1_750_000, 2_000_000, 2_250_000]);
  assert.deepEqual(enc.encodes.map((e) => e.keyFrame), [true, false, false, false, false, false], "only the first frame is a key frame");
  enc.emit(0, true);
  for (let i = 1; i < 6; i++) enc.emit(i);
  const chunks = a.sent.filter((m) => m.t === "video-chunk") as { rtp: number }[];
  assert.deepEqual(chunks.map((c) => c.rtp), rtps);
  assert.equal(a.sent.filter((m) => m.t === "video-drop").length, 0);
});

test("agent: a frame the encoder swallows is reported as dropped and later chunks keep their own timestamps", async () => {
  const a = startAgent();
  await a.command({ t: "start", source: { kind: "tab", mediaSourceId: "x" }, video: { width: 640, height: 360, frameRate: 30, resolutionChangePolicy: "fixed_resolution" } });
  for (let i = 0; i < 3; i++) await a.capture(i * 33_000);
  const rtps = a.rtps();
  for (const r of rtps) await a.command({ t: "encode", rtp: r });
  const enc = a.encoders[0]!;
  enc.emit(0, true);
  enc.emit(2);
  assert.deepEqual(a.sent.filter((m) => m.t === "video-drop").map((m) => (m as { rtp: number }).rtp), [rtps[1]]);
  assert.deepEqual((a.sent.filter((m) => m.t === "video-chunk") as { rtp: number }[]).map((c) => c.rtp), [rtps[0], rtps[2]]);
});

test("agent: a full encoder queue, a missing frame and an encoder error each report a drop", async () => {
  const a = startAgent();
  await a.command({ t: "start", source: { kind: "tab", mediaSourceId: "x" }, video: { width: 640, height: 360, frameRate: 30, resolutionChangePolicy: "fixed_resolution" } });
  for (let i = 0; i < 3; i++) await a.capture(i * 33_000);
  const rtps = a.rtps();
  await a.command({ t: "encode", rtp: rtps[0]! });
  const enc = a.encoders[0]!;
  enc.encodeQueueSize = 5;
  await a.command({ t: "encode", rtp: rtps[1]! });
  assert.equal(enc.encodes.length, 1, "the full queue took no frame");
  await a.command({ t: "encode", rtp: 999_999 });
  assert.deepEqual(a.sent.filter((m) => m.t === "video-drop").map((m) => (m as { rtp: number }).rtp), [rtps[1], 999_999]);
  enc.init.error(new Error("boom"));
  assert.ok(a.sent.some((m) => m.t === "video-drop" && m.rtp === rtps[0]), "the frame inside a failed encoder is dropped");
  assert.ok(a.sent.some((m) => m.t === "encoder-status" && m.status === "codec_runtime_error"));
});

class FakePort implements AgentPort {
  readonly out: EngineToAgent[] = [];
  private l: ((m: AgentToEngine) => void) | undefined;
  postMessage(m: EngineToAgent) { this.out.push(m); }
  onMessage(l: (m: AgentToEngine) => void) { this.l = l; }
  close() {}
  emit(m: AgentToEngine) { this.l?.(m); }
}

test("port backend: a dropped video frame becomes an encoder drop, which frees its slot in the sender", () => {
  const port = new FakePort();
  const backend = new PortBackend(port, { kind: "tab", mediaSourceId: "x" });
  const got: { ref: number; length: number | undefined }[] = [];
  const encoder = backend.createVideoEncoder(
    { maxFrameRate: 30, startBitrate: 1e6, codecParameter: "vp8", videoCodec: "vp8" } as never,
    { onEncoded: (ref, f) => got.push({ ref, length: f?.data.length }), onStatus() {} },
  );
  assert.equal(encoder.encodeVideoFrame({ rtpTimestamp: 100, visibleRectEmpty: false }, 5000), true);
  assert.equal(encoder.encodeVideoFrame({ rtpTimestamp: 200, visibleRectEmpty: false }, 5033), true);
  port.emit({ t: "video-drop", rtp: 100 });
  port.emit({ t: "video-chunk", rtp: 200, key: true, data: new ArrayBuffer(3), encodeMs: 1 });
  port.emit({ t: "video-drop", rtp: 100 });
  assert.deepEqual(got, [{ ref: 5000, length: 0 }, { ref: 5033, length: 3 }], "each frame is answered exactly once");
});

test("port backend: audio timestamps follow the recorded times, and a lost chunk is reported as skipped samples", () => {
  const port = new FakePort();
  const backend = new PortBackend(port, { kind: "tab", mediaSourceId: "x" });
  const frames: { id: number; rtp: number; ref: number; skipped: number }[] = [];
  const base = performance.timeOrigin;
  const encoder = backend.createAudioEncoder({ rtpTimebase: 48000, maxBitrate: 128000 } as never, {
    onEncoded: (f, skipped) => frames.push({ id: f.frameId, rtp: f.rtpTimestamp, ref: f.referenceTimeMs, skipped }),
    onStatus() {},
  });
  backend.startAudioCapture({ sampleRate: 48000, channels: 2, framesPerBuffer: 480 }, {
    insertAudio: (n, rec) => { encoder.encode(n, rec); return true; },
    onCaptureError() {},
  });
  const buffer = (seq: number, rec: number) => port.emit({ t: "audio-buffer", seq, frames: 480, recMs: base + rec });
  const chunk = (seq: number) => port.emit({ t: "audio-chunk", seq, data: new ArrayBuffer(2) });
  buffer(0, 1000); chunk(0);
  buffer(1, 1010); port.emit({ t: "audio-drop", seq: 1 });
  buffer(2, 1020); chunk(2);
  // 7 frames of silence: more than kUnderrunSkipThreshold, so the RTP timestamp jumps ahead.
  assert.ok(7 > UNDERRUN_SKIP_THRESHOLD);
  buffer(3, 1100); chunk(3);
  assert.deepEqual(frames, [
    { id: 0, rtp: 0, ref: 1000, skipped: 0 },
    { id: 2, rtp: 960, ref: 1020, skipped: 480 },
    { id: 3, rtp: 1440 + 7 * 480, ref: 1100, skipped: 0 },
  ]);
});

test("agent: a refresh frame on a static screen is stamped with the elapsed time, not one tick", async () => {
  const a = startAgent();
  await a.command({ t: "start", source: { kind: "tab", mediaSourceId: "x" }, video: { width: 640, height: 360, frameRate: 30, resolutionChangePolicy: "fixed_resolution" } });
  await a.capture(0);
  const first = a.rtps()[0]!;
  a.advance(200);
  await a.command({ t: "refresh" });
  a.advance(50);
  await a.command({ t: "refresh" });
  const [, second, third] = a.rtps();
  // 33 ms passed between the capture's reference time and the first refresh request, then 200, then 50.
  assert.ok(Math.abs(second! - first - 200 * 90) < 90, `second ${second! - first}`);
  assert.ok(Math.abs(third! - second! - 50 * 90) < 90, `third ${third! - second!}`);
});

test("agent: a frozen device delivers nothing and ignores refresh requests; unfreezing sends the last frame again, and capture goes on", async () => {
  const a = startAgent();
  await a.command({ t: "start", source: { kind: "tab", mediaSourceId: "x" }, video: { width: 640, height: 360, frameRate: 30, resolutionChangePolicy: "fixed_resolution" as const } });
  await a.capture(0);
  assert.equal(a.rtps().length, 1);
  await a.command({ t: "freeze" });
  await a.capture(33_000);
  await a.capture(66_000);
  a.advance(300);
  await a.command({ t: "refresh" });
  assert.equal(a.rtps().length, 1, "no frame while frozen, from capture or from a refresh request");
  a.advance(100);
  await a.command({ t: "unfreeze" });
  const rtps = a.rtps();
  assert.equal(rtps.length, 2, "a restarted capturer delivers a frame at once");
  assert.ok(rtps[1]! > rtps[0]! + 400 * 90 - 90, `stamped with the time that passed: ${rtps[1]! - rtps[0]!}`);
  await a.capture(99_000);
  assert.equal(a.rtps().length, 3, "capture goes on");
  await a.command({ t: "unfreeze" });
  assert.equal(a.rtps().length, 3, "unfreezing a device that is not frozen does nothing");
});

test("agent: a tab switch captures the new source with the same limits and carries the RTP timeline and encoder over", async () => {
  const a = startAgent();
  const video = { width: 640, height: 360, frameRate: 30, resolutionChangePolicy: "fixed_resolution" as const };
  await a.command({ t: "start", source: { kind: "tab", mediaSourceId: "old-tab" }, video });
  await a.capture(5_000_000);
  await a.capture(5_033_000);
  await a.command({ t: "encode", rtp: a.rtps()[1]! });
  const lastRtp = a.rtps()[1]!;
  await a.command({ t: "freeze" });
  await a.command({ t: "switch", source: { kind: "tab", mediaSourceId: "new-tab" }, video: true, audio: false });
  assert.equal(a.requests.length, 2);
  // The same capture limits as the start (RestartWithParams with the same parameters), only the source differs.
  assert.deepEqual(JSON.parse(JSON.stringify(a.requests[1]!.video!.mandatory)), { ...JSON.parse(JSON.stringify(a.requests[0]!.video!.mandatory)), chromeMediaSourceId: "new-tab" });
  assert.deepEqual(JSON.parse(JSON.stringify(a.requests[1]!.video!.mandatory)), { chromeMediaSource: "tab", chromeMediaSourceId: "new-tab", minWidth: 640, minHeight: 360, maxWidth: 640, maxHeight: 360, maxFrameRate: 30 });
  assert.equal(a.tracks[0]!.stopped, true, "the old tab's capture ends");
  assert.equal(a.tracks[1]!.stopped, false);
  // The refresh of the old tab's last frame must not be sent as the new tab's.
  a.advance(500);
  await a.command({ t: "refresh" });
  assert.equal(a.rtps().length, 2);
  // The new capture's clock starts elsewhere; its first frame continues 1 ms after the last frame sent, and it is not frozen.
  await a.capture(100);
  await a.capture(33_100);
  const [first, second] = a.rtps().slice(2);
  assert.equal(first, lastRtp + 90);
  assert.equal(second! - first!, 33 * 90 - 0);
  await a.command({ t: "encode", rtp: first! });
  assert.equal(a.encoders.length, 1, "the session's encoder carries on (same frame size)");
  assert.equal(a.encoders[0]!.encodes.map((e) => e.keyFrame).filter(Boolean).length, 1, "no new key frame is forced by a switch");
});

test("agent: a tab that cannot be captured is reported as a video capture error and the old capture is not touched", async () => {
  const a = startAgent();
  await a.command({ t: "start", source: { kind: "tab", mediaSourceId: "x" }, video: { width: 640, height: 360, frameRate: 30, resolutionChangePolicy: "fixed_resolution" as const } });
  a.refuse.next = true;
  await a.command({ t: "switch", source: { kind: "tab", mediaSourceId: "gone" }, video: true, audio: false });
  assert.ok(a.sent.some((m) => m.t === "error" && m.where === "video" && m.message.includes("denied")));
  assert.equal(a.tracks[0]!.stopped, false);
});

test("port backend: a switch is one agent message for both streams with the new source, and nothing is sent before capture started", async () => {
  const port = new FakePort();
  const backend = new PortBackend(port, { kind: "tab", mediaSourceId: "old" });
  backend.switchVideoCaptureHost();
  await Promise.resolve();
  assert.equal(port.out.length, 0, "no capture yet: the start will carry the new source");
  backend.startVideoCapture({ width: 640, height: 360, frameRate: 30, resolutionChangePolicy: "fixed_resolution" as const } as never, { insertVideoFrame() {}, onCaptureError() {} });
  backend.startAudioCapture({ sampleRate: 48000, channels: 2, framesPerBuffer: 480 }, { insertAudio: () => true, onCaptureError() {} });
  await Promise.resolve();
  assert.deepEqual(port.out.map((m) => m.t), ["start"]);
  assert.deepEqual((port.out[0] as { source: unknown }).source, { kind: "tab", mediaSourceId: "old" });
  backend.setSource({ kind: "tab", mediaSourceId: "new" });
  backend.switchVideoCaptureHost();
  backend.restartAudioCapture();
  await Promise.resolve();
  assert.deepEqual(port.out.slice(1), [{ t: "switch", source: { kind: "tab", mediaSourceId: "new" }, video: true, audio: true }]);
  backend.suspendVideoDevice();
  backend.resumeVideoDevice();
  assert.deepEqual(port.out.slice(2), [{ t: "freeze" }, { t: "unfreeze" }]);
});

test("agent: the video encoder is configured like Chrome's MediaVideoEncoderWrapper (constant bitrate, screen content hint, no frame rate for VP8)", async () => {
  const a = startAgent();
  await a.command({ t: "start", source: { kind: "tab", mediaSourceId: "x" }, video: { width: 640, height: 360, frameRate: 30, resolutionChangePolicy: "fixed_resolution" as const } });
  await a.capture(0);
  await a.command({ t: "encode", rtp: a.rtps()[0]! });
  const cfg = a.encoders[0]!.configures[0]!;
  assert.equal(cfg.bitrateMode, "constant");
  assert.equal(cfg.contentHint, "text");
  assert.equal("framerate" in cfg, false);
  assert.equal(cfg.latencyMode, "realtime");
});

// media_video_encoder_wrapper.cc: `options_.framerate` only `if (is_hardware_encoder_)`, and the screen content hint
// `if (codec_ != media::VideoCodec::kVP9 || is_hardware_encoder_)`.
test("agent: a software VP9 encoder gets neither a frame rate nor the screen content hint", async () => {
  const a = startAgent();
  await a.command({ t: "set-codec", codec: "vp9", codecString: "vp09.00.10.08", hardware: false });
  await a.command({ t: "start", source: { kind: "tab", mediaSourceId: "x" }, video: { width: 640, height: 360, frameRate: 30, resolutionChangePolicy: "fixed_resolution" as const } });
  await a.capture(0);
  await a.command({ t: "encode", rtp: a.rtps()[0]! });
  const cfg = a.encoders[0]!.configures[0]!;
  assert.equal(cfg.bitrateMode, "constant");
  assert.equal("contentHint" in cfg, false);
  assert.equal("framerate" in cfg, false);
});

test("agent: a hardware encoder gets the frame rate and the screen content hint, VP9 included", async () => {
  for (const [codec, codecString] of [["h264", "avc1.4d0028"], ["vp9", "vp09.00.40.08"]] as const) {
    const a = startAgent();
    await a.command({ t: "set-codec", codec, codecString, hardware: true });
    await a.command({ t: "start", source: { kind: "tab", mediaSourceId: "x" }, video: { width: 640, height: 360, frameRate: 30, resolutionChangePolicy: "fixed_resolution" as const } });
    await a.capture(0);
    await a.command({ t: "encode", rtp: a.rtps()[0]! });
    const cfg = a.encoders[0]!.configures[0]!;
    assert.equal(cfg.bitrateMode, "constant", codec);
    assert.equal(cfg.contentHint, "text", codec);
    assert.equal(cfg.framerate, 30, codec);
  }
});

// Objects built inside the vm context have another realm's prototypes.
const plain = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

const startTab = (a: ReturnType<typeof startAgent>, resolutionChangePolicy: "fixed_resolution" | "fixed_aspect_ratio" | "any_within_limit" = "fixed_resolution", width = 1920, height = 1080) =>
  a.command({ t: "start", source: { kind: "tab", mediaSourceId: "x" }, video: { width, height, frameRate: 30, resolutionChangePolicy } });

test("agent: a hardware offer configures a hardware-only encoder and H.264 as Annex B", async () => {
  const a = startAgent();
  await a.command({ t: "set-codec", codec: "h264", codecString: "avc1.4d0028", hardware: true });
  await startTab(a);
  await a.capture(0);
  await a.command({ t: "encode", rtp: a.rtps()[0]! });
  const expected = { codec: "avc1.4d0028", hardwareAcceleration: "prefer-hardware", avc: { format: "annexb" } };
  assert.deepEqual(plain(a.supportChecks.map((c) => ({ codec: c.codec, hardwareAcceleration: c.hardwareAcceleration, avc: c.avc }))), [expected]);
  assert.deepEqual(plain(a.encoders[0]!.configures.map((c) => ({ codec: c.codec, hardwareAcceleration: c.hardwareAcceleration, avc: c.avc }))), [expected]);
});

test("agent: a software offer asks for a software encoder", async () => {
  const a = startAgent();
  await a.command({ t: "set-codec", codec: "vp8", codecString: "", hardware: false });
  await startTab(a);
  await a.capture(0);
  await a.command({ t: "encode", rtp: a.rtps()[0]! });
  assert.equal(a.encoders[0]!.configures[0]!.hardwareAcceleration, "prefer-software");
  assert.equal(a.encoders[0]!.configures[0]!.avc, undefined);
});

test("agent: a hardware encoder that is no longer supported is reported with what was asked", async () => {
  const a = startAgent();
  await a.command({ t: "set-codec", codec: "h264", codecString: "avc1.4d0028", hardware: true });
  await startTab(a);
  a.control.supported = (c) => c.hardwareAcceleration !== "prefer-hardware";
  await a.capture(0);
  await a.command({ t: "encode", rtp: a.rtps()[0]! });
  assert.equal(a.encoders.length, 0);
  assert.deepEqual(plain(a.sent.filter((m) => m.t === "encoder-status")), [{ t: "encoder-status", kind: "video", status: "unsupported_codec", message: "avc1.4d0028 (hardware) at 640x360" }]);
  assert.ok(a.sent.some((m) => m.t === "video-drop"));
});

test("agent: an encoder error is one status carrying the error, not a status and a separate error", async () => {
  const a = startAgent();
  await startTab(a);
  await a.capture(0);
  await a.command({ t: "encode", rtp: a.rtps()[0]! });
  a.encoders[0]!.init.error(new Error("GPU lost"));
  assert.deepEqual(plain(a.sent.filter((m) => m.t === "encoder-status")), [{ t: "encoder-status", kind: "video", status: "codec_runtime_error", message: "Error: GPU lost" }]);
  assert.equal(a.sent.filter((m) => m.t === "error").length, 0);
});

test("agent: a new codec choice replaces the running encoder, and in-flight frames are reported dropped", async () => {
  const a = startAgent();
  await a.command({ t: "set-codec", codec: "h264", codecString: "avc1.4d0028", hardware: true });
  await startTab(a);
  for (let i = 0; i < 2; i++) await a.capture(i * 33_000);
  const rtps = a.rtps();
  await a.command({ t: "encode", rtp: rtps[0]! });
  const old = a.encoders[0]!;
  await a.command({ t: "set-codec", codec: "vp8", codecString: "", hardware: false });
  assert.equal(old.state, "closed");
  assert.deepEqual(a.sent.filter((m) => m.t === "video-drop").map((m) => (m as { rtp: number }).rtp), [rtps[0]]);
  await a.command({ t: "encode", rtp: rtps[1]! });
  assert.equal(a.encoders.length, 2, "the next frame configures a new encoder at the same size");
  assert.deepEqual([a.encoders[1]!.configures[0]!.codec, a.encoders[1]!.configures[0]!.hardwareAcceleration], ["vp8", "prefer-software"]);
  assert.equal(a.encoders[1]!.encodes[0]!.keyFrame, true, "the new stream starts with a key frame");
});

// Blink media_stream_constraints_util_video_content.cc SelectResolutionPolicyFromCandidates, which turns the sizes of a
// getUserMedia request into the resolution_change_policy of the capture device (kMinScreenCastDimension is 1).
function blinkPolicy(c: Record<string, number>): string {
  if (!(c.maxHeight! < 1 << 14 && c.maxWidth! < 1 << 14 && c.minHeight! > 1 && c.minWidth! > 1)) return "default";
  if (c.minHeight === c.maxHeight && c.minWidth === c.maxWidth) return "fixed_resolution";
  const approx = (w: number, h: number): number => Math.floor((100 * w) / h);
  return approx(c.minWidth!, c.minHeight!) === approx(c.maxWidth!, c.maxHeight!) ? "fixed_aspect_ratio" : "any_within_limit";
}

test("agent: the capture sizes make Blink choose the resolution_change_policy the session host asked for", async () => {
  for (const policy of ["fixed_resolution", "fixed_aspect_ratio", "any_within_limit"] as const) {
    for (const [w, h] of [[1920, 1080], [1280, 720], [1024, 768], [800, 600], [1000, 1000], [854, 480], [1921, 1081], [320, 180]] as const) {
      const a = startAgent();
      await startTab(a, policy, w, h);
      const mandatory = (a.userMedia[0]!.video as { mandatory: Record<string, number> }).mandatory;
      const ew = w - (w % 2), eh = h - (h % 2);
      assert.equal(mandatory.maxWidth, ew);
      assert.equal(mandatory.maxHeight, eh);
      // VideoCaptureParams::SuggestConstraints: fixed_resolution is min = max; a fixed aspect ratio's minimum is 180 lines high;
      // any_within_limit's is 2x2. A size at or below 180 lines has no smaller aspect-ratio-preserving size, so it is fixed.
      const expected = policy === "fixed_aspect_ratio" && eh <= 180 ? "fixed_resolution" : policy;
      assert.equal(blinkPolicy(mandatory), expected, `${policy} ${w}x${h}: ${JSON.stringify(mandatory)}`);
      if (policy === "fixed_aspect_ratio" && eh > 180) assert.equal(mandatory.minHeight! >= 180 && mandatory.minWidth! % 2 === 0, true);
    }
  }
});

test("agent: a 1920x1080 fixed aspect ratio capture has a 320x180 minimum, as SuggestConstraints computes it", async () => {
  const a = startAgent();
  await startTab(a, "fixed_aspect_ratio");
  const m = (a.userMedia[0]!.video as { mandatory: Record<string, unknown> }).mandatory;
  assert.deepEqual([m.minWidth, m.minHeight, m.maxWidth, m.maxHeight, m.maxFrameRate, m.chromeMediaSource], [320, 180, 1920, 1080, 30, "tab"]);
});

test("port backend: a second encoder starts over, ignores the first one's frames, and tells the agent whether to use hardware", () => {
  const port = new FakePort();
  const backend = new PortBackend(port, { kind: "tab", mediaSourceId: "x" });
  const first: (number | undefined)[] = [];
  const second: { id: number | undefined; length: number | undefined }[] = [];
  const statuses: string[] = [];
  const e1 = backend.createVideoEncoder({ maxFrameRate: 30, startBitrate: 1e6, codecParameter: "avc1.4d0028", videoCodec: "h264", useHardwareEncoder: true } as never, { onEncoded: (_r, f) => first.push(f?.frameId), onStatus: (s, m) => statuses.push(`${s}:${m}`) });
  assert.deepEqual(port.out.find((m) => m.t === "set-codec"), { t: "set-codec", codec: "h264", codecString: "avc1.4d0028", hardware: true });
  e1.encodeVideoFrame({ rtpTimestamp: 100, visibleRectEmpty: false }, 5000);
  port.emit({ t: "video-chunk", rtp: 100, key: true, data: new ArrayBuffer(3), encodeMs: 1 });
  e1.encodeVideoFrame({ rtpTimestamp: 200, visibleRectEmpty: false }, 5033);
  port.emit({ t: "encoder-status", kind: "video", status: "codec_runtime_error", message: "GPU lost" });
  assert.deepEqual(statuses, ["codec_runtime_error:GPU lost"]);

  const e2 = backend.createVideoEncoder({ maxFrameRate: 30, startBitrate: 1e6, codecParameter: "", videoCodec: "vp8", useHardwareEncoder: false } as never, { onEncoded: (_r, f) => second.push({ id: f?.frameId, length: f?.data.length }), onStatus() {} });
  assert.deepEqual(port.out.filter((m) => m.t === "set-codec").at(-1), { t: "set-codec", codec: "vp8", codecString: "", hardware: false });
  port.emit({ t: "video-drop", rtp: 200 });
  port.emit({ t: "video-chunk", rtp: 200, key: true, data: new ArrayBuffer(3), encodeMs: 1 });
  assert.deepEqual(second, [], "answers about the first encoder's frames reach nobody");
  e2.encodeVideoFrame({ rtpTimestamp: 300, visibleRectEmpty: false }, 5066);
  port.emit({ t: "video-chunk", rtp: 300, key: true, data: new ArrayBuffer(3), encodeMs: 1 });
  assert.deepEqual(second, [{ id: 0, length: 3 }], "frame ids start again at 0");
  assert.deepEqual(first, [0]);
});

test("port backend: the capture's resolution change policy goes to the agent", () => {
  const port = new FakePort();
  const backend = new PortBackend(port, { kind: "tab", mediaSourceId: "x" });
  backend.startVideoCapture({ width: 1920, height: 1080, frameRate: 30, resolutionChangePolicy: "fixed_aspect_ratio" }, { insertVideoFrame() {}, onCaptureError() {} });
  return Promise.resolve().then(() => {
    assert.deepEqual((port.out.find((m) => m.t === "start") as { video: unknown }).video, { width: 1920, height: 1080, frameRate: 30, resolutionChangePolicy: "fixed_aspect_ratio" });
  });
});

const chunksOf = (sent: AgentToEngine[]) => sent.filter((m) => m.t === "video-chunk") as { rtp: number; complexity?: number; durationMs?: number }[];

test("agent: the frame complexity estimate is the entropy of luma differences over 10% of the rows, as Chrome's", async () => {
  const a = startAgent();
  await a.command({ t: "start", source: { kind: "tab", mediaSourceId: "x" }, video: { width: 640, height: 360, frameRate: 30, resolutionChangePolicy: "fixed_resolution" as const } });
  let seed = 12345;
  const noise = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) >> 16) & 255;
  const ramp = (x: number) => x % 256;
  // key frame (neighbour differences), then delta frames (differences against the last examined frame)
  const frames: FrameOptions[] = [
    { luma: (x) => ramp(x) },            // key: 637 differences of +1 and 2 of -255 per row
    { luma: (x) => ramp(x + 1) },        // delta: every pixel moved by 1 but the two columns where the ramp wraps
    { luma: () => 128 },                 // delta: a uniform frame after a ramp
    { luma: () => noise() },             // delta: noise against uniform, about 8 bits of entropy
  ];
  for (let i = 0; i < frames.length; i++) {
    await a.capture(i * 33_000, frames[i]);
    await a.command({ t: "encode", rtp: a.rtps()[i]! });
  }
  const enc = a.encoders[0]!;
  for (let i = 0; i < frames.length; i++) enc.emit(i, i === 0);
  const c = chunksOf(a.sent).map((m) => m.complexity);
  const p = 2 / 639;
  const keyEntropy = -((1 - p) * Math.log2(1 - p) + p * Math.log2(p));
  assert.ok(Math.abs(c[0]! - keyEntropy / 7.5) < 1e-9, `key frame ${c[0]} vs ${keyEntropy / 7.5}`);
  // The ramp moved by one except where it wraps: two buckets again, 2 of 640 columns in the wrap bucket.
  assert.ok(c[1]! > 0 && c[1]! < 0.1, `ramp delta ${c[1]}`);
  assert.ok(c[2]! > 0.2, "a ramp against a uniform frame is spread over many differences");
  assert.equal(c[3], 1, "noise is capped at the complexity of 7.5 bits");
});

test("agent: a uniform frame has no complexity, an unexaminable format reports none, and the frame duration follows GetFrameDuration", async () => {
  const a = startAgent();
  // 120 fps, so that the capture limiter (SmoothEventSampler) keeps a frame 10 ms after the last; the duration's clamp
  // does not depend on the rate.
  await a.command({ t: "start", source: { kind: "tab", mediaSourceId: "x" }, video: { width: 640, height: 360, frameRate: 120, resolutionChangePolicy: "fixed_resolution" as const } });
  await a.capture(0, { luma: () => 77, duration: 20_000 });        // own duration 20 ms
  await a.capture(500_000, { format: "BGRA" });                    // RGB frames are not examined; no duration: clamped to 1/24 s
  await a.capture(510_000, { format: "NV12", luma: () => 5 });     // 10 ms since the last, clamped up to 1/60 s
  const r = a.rtps();
  for (const x of r) await a.command({ t: "encode", rtp: x });
  const enc = a.encoders[0]!;
  enc.emit(0, true); enc.emit(1); enc.emit(2);
  const c = chunksOf(a.sent);
  assert.equal(c[0]!.complexity, 0);
  assert.ok(!("complexity" in c[1]!), "BGRA is not planar YUV");
  assert.equal(c[2]!.complexity, 0);
  assert.equal(c[0]!.durationMs, 20);
  assert.ok(Math.abs(c[1]!.durationMs! - 1000 / 24) < 1e-9);
  assert.ok(Math.abs(c[2]!.durationMs! - 1000 / 60) < 1e-9);
});

test("agent: the engine's capture size sets the size the encoder is configured for, and only while the aspect ratio matches", async () => {
  const a = startAgent();
  await a.command({ t: "start", source: { kind: "tab", mediaSourceId: "x" }, video: { width: 1280, height: 720, frameRate: 30, resolutionChangePolicy: "fixed_resolution" as const } });
  const sizes = () => a.encoders.flatMap((e) => e.configures.map((c) => `${c.width}x${c.height}`));
  await a.capture(0, { width: 1280, height: 720 });
  await a.command({ t: "encode", rtp: a.rtps()[0]! });
  await a.command({ t: "capture-size", width: 640, height: 360 });
  await a.capture(33_000, { width: 1280, height: 720 });
  await a.command({ t: "encode", rtp: a.rtps()[1]! });
  // The source became portrait before the oracle caught up: its own size wins.
  await a.capture(66_000, { width: 720, height: 1280 });
  await a.command({ t: "encode", rtp: a.rtps()[2]! });
  // A capture size larger than the frame is the frame's size.
  await a.command({ t: "capture-size", width: 1920, height: 1080 });
  await a.capture(99_000, { width: 1280, height: 720 });
  await a.command({ t: "encode", rtp: a.rtps()[3]! });
  assert.deepEqual(sizes(), ["1280x720", "640x360", "720x1280", "1280x720"]);
});

test("agent: the rate limit goes by capture time, so frames that arrive bunched after a stall are kept", async () => {
  const a = startAgent();
  await a.command({ t: "start", source: { kind: "tab", mediaSourceId: "x" }, video: { width: 640, height: 360, frameRate: 30, resolutionChangePolicy: "fixed_resolution" as const } });
  await a.capture(0);
  await a.capture(33_333, { gapMs: 5 }); // delivered 5 ms after the first, captured 33 ms after it
  await a.capture(66_667, { gapMs: 5 });
  await a.capture(70_000, { gapMs: 33 }); // a 3 ms capture interval: too soon, dropped
  const frames = a.sent.filter((m) => m.t === "frame") as { rtp: number; refMs: number }[];
  assert.equal(frames.length, 3);
  assert.deepEqual(frames.map((x) => x.rtp), [90_000, 93_000, 96_000]);
  assert.ok(frames[1]!.refMs > frames[0]!.refMs && frames[2]!.refMs > frames[1]!.refMs, "reference times increase");
});

test("agent: capture statistics are reported every five seconds", async () => {
  const a = startAgent();
  await a.command({ t: "start", source: { kind: "tab", mediaSourceId: "x" }, video: { width: 640, height: 360, frameRate: 30, resolutionChangePolicy: "fixed_resolution" as const } });
  for (let i = 0; i < 40; i++) await a.capture(i * 133_333, { gapMs: 133 });
  const logs = a.sent.filter((m) => m.t === "log") as { message: string }[];
  assert.ok(logs.length >= 1);
  assert.match(logs[0]!.message, /^capture: [\d.]+ fps delivered, [\d.]+ fps kept, 0 dropped by the rate limit; capture interval p50 133\.3 ms/);
});

test("agent: frames are stamped with the capture time from the frame metadata when the source gives one", async () => {
  const a = startAgent();
  await a.command({ t: "start", source: { kind: "tab", mediaSourceId: "x" }, video: { width: 640, height: 360, frameRate: 30, resolutionChangePolicy: "fixed_resolution" as const } });
  await a.capture(0, { gapMs: 33, captureTime: 1000 }); // read at 1033, captured at 1000
  await a.capture(33_333, { gapMs: 33, captureTime: 1033.3 });
  const frames = a.sent.filter((m) => m.t === "frame") as { refMs: number }[];
  assert.equal(frames[0]!.refMs, 1000);
  assert.ok(Math.abs(frames[1]!.refMs - 1033.3) < 1e-6);
});

test("port backend: the capture begin and end times of a frame reach the encoded frame (FRAME_CAPTURE_BEGIN / FRAME_CAPTURE_END)", () => {
  const port = new FakePort();
  const backend = new PortBackend(port, { kind: "tab", mediaSourceId: "x" });
  const base = performance.timeOrigin;
  const seen: { begin: number | undefined; end: number | undefined }[] = [];
  const encoder = backend.createVideoEncoder(
    { maxFrameRate: 30, startBitrate: 1e6, codecParameter: "vp8", videoCodec: "vp8" } as never,
    { onEncoded: (_ref, f) => seen.push({ begin: f?.captureBeginTimeMs, end: f?.captureEndTimeMs }), onStatus() {} },
  );
  backend.startVideoCapture({} as never, {
    insertVideoFrame: (f) => { encoder.encodeVideoFrame(f, f.referenceTimeMs!); },
    onCaptureError() {},
  });
  port.emit({ t: "frame", rtp: 90_000, refMs: base + 1000, width: 640, height: 360, captureBeginMs: base + 1000, captureEndMs: base + 1004 });
  port.emit({ t: "video-chunk", rtp: 90_000, key: true, data: new ArrayBuffer(3), encodeMs: 1 });
  port.emit({ t: "frame", rtp: 93_000, refMs: base + 1033, width: 640, height: 360 });
  port.emit({ t: "video-chunk", rtp: 93_000, key: false, data: new ArrayBuffer(3), encodeMs: 1 });
  assert.deepEqual(seen, [{ begin: 1000, end: 1004 }, { begin: undefined, end: undefined }]);
});

test("agent: a source that paints at 60 Hz is thinned to the target rate", async () => {
  const a = startAgent();
  await a.command({ t: "start", source: { kind: "tab", mediaSourceId: "x" }, video: { width: 640, height: 360, frameRate: 30, resolutionChangePolicy: "fixed_resolution" as const } });
  for (let i = 0; i < 120; i++) await a.capture(Math.round(i * 16_667));
  const kept = a.sent.filter((m) => m.t === "frame").length;
  assert.ok(kept >= 59 && kept <= 62, `kept ${kept} of 120 frames at 60 Hz`);
});

test("agent: pairs of frames 17 ms apart with 90 ms gaps are all kept (Chrome's SmoothEventSampler token bucket)", async () => {
  const a = startAgent();
  await a.command({ t: "start", source: { kind: "tab", mediaSourceId: "x" }, video: { width: 640, height: 360, frameRate: 30, resolutionChangePolicy: "fixed_resolution" as const } });
  let t = 0;
  for (let burst = 0; burst < 40; burst++) {
    await a.capture(Math.round(t * 1000));
    await a.capture(Math.round((t + 16.7) * 1000));
    t += 16.7 + 90;
  }
  assert.equal(a.sent.filter((m) => m.t === "frame").length, 80);
});
