import { test } from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { runEngineProcess, type FromEngine, type MessagePortLike, type ToEngine } from "../../src/mirroring/electron/engine-process.ts";
import type { AgentToEngine, EngineToAgent } from "../../src/mirroring/electron/agent-protocol.ts";
import { makeOpusPacket, makeVp8Frame } from "./fake-backend.ts";
import { FakeReceiver } from "./fake-receiver.ts";
import { sleep } from "./session-harness.ts";

/**
 * The engine process entry driven through its real message protocol, with a scripted stand-in for the renderer
 * agent on the other end of the port: it emits raw frames and audio buffers and answers encode requests with VP8 and
 * Opus packets, exactly as agent-source.ts does. Nothing here needs Electron.
 */

class FakeAgentPort implements MessagePortLike {
  readonly received: EngineToAgent[] = [];
  private listener: ((e: { data: unknown }) => void) | undefined;
  private timers: NodeJS.Timeout[] = [];
  private bitrate = 2_000_000;
  private key = true;
  closed = false;
  private seq = 0;
  private rtp = 90000;

  postMessage(message: unknown): void {
    const m = message as EngineToAgent;
    this.received.push(m);
    switch (m.t) {
      case "start":
        if (m.video) this.timers.push(setInterval(() => this.emit({ t: "frame", rtp: (this.rtp += 3000), refMs: performance.timeOrigin + performance.now(), width: 1280, height: 720 }), 33));
        if (m.audio) this.timers.push(setInterval(() => this.emit({ t: "audio-buffer", seq: this.seq++, frames: 480, recMs: performance.timeOrigin + performance.now() }), 10));
        break;
      case "set-bitrate":
        this.bitrate = m.bps;
        break;
      case "key-frame":
        this.key = true;
        break;
      case "encode": {
        const key = this.key;
        this.key = false;
        const data = makeVp8Frame(key, m.rtp, Math.round(this.bitrate / 8 / 30) * (key ? 3 : 1));
        setTimeout(() => this.emit({ t: "video-chunk", rtp: m.rtp, key, data: data.buffer.slice(data.byteOffset, data.byteOffset + data.length) as ArrayBuffer, encodeMs: 4 }), 3);
        break;
      }
      case "encode-audio": {
        const data = makeOpusPacket(m.seq, 160);
        this.emit({ t: "audio-chunk", seq: m.seq, data: data.buffer.slice(data.byteOffset, data.byteOffset + data.length) as ArrayBuffer });
        break;
      }
      case "stop":
        for (const t of this.timers) clearInterval(t);
        break;
      default:
        break;
    }
  }
  on(_event: "message", listener: (e: { data: unknown }) => void): void {
    this.listener = listener;
  }
  start(): void {}
  close(): void {
    this.closed = true;
    for (const t of this.timers) clearInterval(t);
  }
  private emit(m: AgentToEngine): void {
    if (!this.closed) this.listener?.({ data: m });
  }
}

test("the engine process streams frames from a port-driven agent to the receiver", async () => {
  const receiver = await FakeReceiver.create({ verifyBody: false });
  const toMain: FromEngine[] = [];
  let onToEngine: ((e: { data: ToEngine; ports: MessagePortLike[] }) => void) | undefined;
  let exited = false;
  runEngineProcess(
    {
      postMessage: (m) => {
        toMain.push(m);
        if (m.type === "send") receiver.onControlMessage(m.namespace, m.json);
      },
      on: (_event, listener) => {
        onToEngine = listener;
      },
    },
    () => {
      exited = true;
    },
  );
  receiver.sendControl = (json) => setImmediate(() => onToEngine!({ data: { type: "message", namespace: "urn:x-cast:com.google.cast.webrtc", json }, ports: [] }));
  const agent = new FakeAgentPort();
  onToEngine!({
    data: {
      type: "start",
      params: { type: "audio_video", receiverAddress: "127.0.0.1", sourceId: "sender-1", destinationId: "transport-1" },
      source: { kind: "tab", mediaSourceId: "tab-id" },
      softwareCodecs: ["vp8"],
      env: {},
    },
    ports: [agent],
  });
  try {
    await sleep(2000);
    const start = agent.received.find((m) => m.t === "start");
    assert.ok(start && start.t === "start");
    assert.deepEqual(start.source, { kind: "tab", mediaSourceId: "tab-id" });
    assert.equal(start.video?.frameRate, 30);
    assert.equal(start.audio?.sampleRate, 48000);
    assert.deepEqual(agent.received.find((m) => m.t === "set-codec"), { t: "set-codec", codec: "vp8", codecString: "" });
    const s = receiver.stats;
    console.log(`engine process: video ${s.videoFrames} frames (${s.videoKeyFrames} key), audio ${s.audioFrames} frames, invalid ${s.invalidFrames}`);
    assert.ok(s.validVideoFrames > 20, `video ${s.validVideoFrames}`);
    assert.ok(s.validAudioFrames > 60, `audio ${s.validAudioFrames}`);
    assert.equal(s.invalidFrames, 0);
    assert.ok(!toMain.some((m) => m.type === "error"), JSON.stringify(toMain.filter((m) => m.type === "error")));
  } finally {
    onToEngine!({ data: { type: "stop" }, ports: [] });
    await sleep(50);
    assert.ok(exited);
    assert.ok(agent.received.some((m) => m.t === "stop"));
    assert.ok(agent.closed);
    receiver.close();
  }
});

test("the engine process relays a tab switch and freeze and unfreeze to the agent, and the stream goes on", async () => {
  const receiver = await FakeReceiver.create({ verifyBody: false });
  let onToEngine: ((e: { data: ToEngine; ports: MessagePortLike[] }) => void) | undefined;
  runEngineProcess(
    {
      postMessage: (m) => {
        if (m.type === "send") receiver.onControlMessage(m.namespace, m.json);
      },
      on: (_event, listener) => {
        onToEngine = listener;
      },
    },
    () => {},
  );
  receiver.sendControl = (json) => setImmediate(() => onToEngine!({ data: { type: "message", namespace: "urn:x-cast:com.google.cast.webrtc", json }, ports: [] }));
  const agent = new FakeAgentPort();
  onToEngine!({
    data: {
      type: "start",
      params: { type: "audio_video", receiverAddress: "127.0.0.1", sourceId: "sender-1", destinationId: "transport-1" },
      source: { kind: "tab", mediaSourceId: "old-tab" },
      softwareCodecs: ["vp8"],
      env: {},
    },
    ports: [agent],
  });
  try {
    await sleep(1200);
    const offers = receiver.lastOffer;
    const before = receiver.stats.validVideoFrames;
    onToEngine!({ data: { type: "switch-source", webContentsId: 8, source: { kind: "tab", mediaSourceId: "new-tab" } }, ports: [] });
    onToEngine!({ data: { type: "pause" }, ports: [] });
    onToEngine!({ data: { type: "resume" }, ports: [] });
    await sleep(500);
    const switched = agent.received.find((m) => m.t === "switch");
    assert.deepEqual(switched, { t: "switch", source: { kind: "tab", mediaSourceId: "new-tab" }, video: true, audio: true });
    assert.deepEqual(agent.received.filter((m) => m.t === "freeze" || m.t === "unfreeze").map((m) => m.t), ["freeze", "unfreeze"]);
    assert.equal(receiver.lastOffer, offers, "no renegotiation");
    assert.ok(receiver.stats.validVideoFrames > before + 5);
    assert.equal(receiver.stats.invalidFrames, 0);
  } finally {
    onToEngine!({ data: { type: "stop" }, ports: [] });
    await sleep(50);
    receiver.close();
  }
});
