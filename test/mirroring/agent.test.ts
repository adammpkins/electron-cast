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

interface FakeFrame { timestamp: number; displayWidth: number; displayHeight: number; closed: boolean; close(): void; clone(): FakeFrame }
const frame = (timestamp: number): FakeFrame => ({
  timestamp, displayWidth: 640, displayHeight: 360, closed: false,
  close() { this.closed = true; },
  clone() { return frame(this.timestamp); },
});

function startAgent() {
  const sent: AgentToEngine[] = [];
  const port = { postMessage: (m: AgentToEngine) => void sent.push(m), start() {}, onmessage: undefined as ((e: { data: unknown }) => void) | undefined };
  let listener: ((e: { data: unknown; ports: unknown[] }) => void) | undefined;
  let now = 1000;
  const encoders: FakeEncoder[] = [];
  const supportChecks: Record<string, unknown>[] = [];
  const userMedia: Record<string, unknown>[] = [];
  const control = { supported: (_config: Record<string, unknown>) => true };
  const waiters: ((r: { value?: FakeFrame; done: boolean }) => void)[] = [];
  const queued: FakeFrame[] = [];

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

  const track = { stop() {} };
  const context = createContext({
    window: { addEventListener: (_: string, l: typeof listener) => { listener = l; } },
    performance: { timeOrigin: 0, now: () => now },
    navigator: { mediaDevices: { getUserMedia: async (constraints: Record<string, unknown>) => (userMedia.push(constraints), { getVideoTracks: () => [track], getAudioTracks: () => [], getTracks: () => [track] }) } },
    MediaStreamTrackProcessor: class { readable = { getReader: () => ({ read: () => queued.length > 0 ? Promise.resolve({ value: queued.shift(), done: false }) : new Promise((r) => waiters.push(r)) }) }; },
    VideoEncoder: FakeEncoder,
    ArrayBuffer, Uint8Array, Map, String, Math, Promise,
  });
  runInContext(AGENT_SOURCE, context);
  listener!({ data: "electron-cast-mirroring:port", ports: [port] });

  const settle = () => new Promise((r) => setTimeout(r, 5));
  return {
    sent, encoders, settle, supportChecks, userMedia, control,
    advance: (ms: number) => { now += ms; },
    command: async (m: EngineToAgent) => { await (port.onmessage as (e: { data: unknown }) => Promise<void>)({ data: m }); await settle(); },
    capture: async (ts: number) => {
      now += 33;
      const f = frame(ts);
      const w = waiters.shift();
      if (w) w({ value: f, done: false }); else queued.push(f);
      await settle();
    },
    rtps: () => sent.filter((m) => m.t === "frame").map((m) => (m as { rtp: number }).rtp),
  };
}

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
