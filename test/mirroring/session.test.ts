import { test } from "node:test";
import assert from "node:assert/strict";
import { SenderSessionMessenger, REPLY_TIMEOUT_MS } from "../../src/mirroring/protocol/messenger.ts";
import { ErrorCode, SessionError } from "../../src/mirroring/protocol/errors.ts";
import { CAST_REMOTING_NAMESPACE, CAST_WEBRTC_NAMESPACE } from "../../src/mirroring/protocol/constants.ts";
import { MirrorSettings, getCodecParameterString, getPlayoutDelayMs } from "../../src/mirroring/mirror-settings.ts";
import { startHarness, sleep } from "./session-harness.ts";

// messenger: sender_session.cc/SenderSessionMessenger (openscreen cast/streaming/impl/session_messager.cc).

function makeMessenger() {
  const sent: { dest: string; ns: string; msg: string }[] = [];
  const errors: SessionError[] = [];
  const timers: { cb: () => void; ms: number; cancelled: boolean }[] = [];
  const m = new SenderSessionMessenger(
    { postMessage: (dest, ns, msg) => sent.push({ dest, ns, msg }) },
    "sender-1",
    "receiver-1",
    (e) => errors.push(e),
    {
      setTimeout(cb, ms) {
        const t = { cb, ms, cancelled: false };
        timers.push(t);
        return () => (t.cancelled = true);
      },
    },
  );
  return { m, sent, errors, timers };
}

test("a request goes to the webrtc namespace and times out after 4 s with MessageTimeout", () => {
  const { m, sent, timers } = makeMessenger();
  let reply: unknown;
  m.sendRequest({ type: "OFFER", seqNum: 7 }, "ANSWER", (r) => (reply = r));
  assert.equal(sent[0]!.ns, CAST_WEBRTC_NAMESPACE);
  assert.equal(sent[0]!.dest, "receiver-1");
  assert.equal(timers[0]!.ms, REPLY_TIMEOUT_MS);
  assert.equal(REPLY_TIMEOUT_MS, 4000);
  timers[0]!.cb();
  assert.ok(reply instanceof SessionError);
  assert.equal((reply as SessionError).code, ErrorCode.MessageTimeout);
});

test("a reply is matched on seqNum; wrong source and wrong namespace are ignored", () => {
  const { m } = makeMessenger();
  let reply: { type?: string } | undefined;
  m.sendRequest({ type: "OFFER", seqNum: 7 }, "ANSWER", (r) => (reply = r as { type?: string }));
  const answer = JSON.stringify({ type: "ANSWER", seqNum: 8, result: "ok", answer: { udpPort: 1, sendIndexes: [0], ssrcs: [1] } });
  m.onMessage("receiver-1", CAST_WEBRTC_NAMESPACE, answer);
  assert.equal(reply, undefined);
  const right = JSON.stringify({ type: "ANSWER", seqNum: 7, result: "ok", answer: { udpPort: 1, sendIndexes: [0], ssrcs: [1] } });
  m.onMessage("someone-else", CAST_WEBRTC_NAMESPACE, right);
  m.onMessage("receiver-1", "urn:x-cast:other", right);
  assert.equal(reply, undefined);
  m.onMessage("receiver-1", CAST_WEBRTC_NAMESPACE, right);
  assert.equal((reply as unknown as { type?: string } | undefined)?.type, "ANSWER");
});

test("the wildcard source is accepted, and invalid JSON is reported as JsonParseError", () => {
  const { m, errors } = makeMessenger();
  m.onMessage("*", CAST_REMOTING_NAMESPACE, "{not json");
  assert.equal(errors[0]?.code, ErrorCode.JsonParseError);
});

test("RPC messages are sent to the remoting namespace", () => {
  const { m, sent } = makeMessenger();
  m.sendRpcMessage(new Uint8Array([1, 2, 3]));
  assert.equal(sent[0]!.ns, CAST_REMOTING_NAMESPACE);
  assert.equal(JSON.parse(sent[0]!.msg).type, "RPC");
});

// mirror_settings.cc GetCodecParameterString / BuildH264MimeSuffix.

test("codec parameter strings", () => {
  assert.equal(getCodecParameterString("vp9", 1280, 720, 30), "vp09.00.40.08");
  assert.equal(getCodecParameterString("vp9", 3840, 2160, 30), "vp09.00.41.08");
  assert.equal(getCodecParameterString("vp9", 1280, 720, 60), "vp09.00.41.08");
  assert.equal(getCodecParameterString("hevc", 1280, 720, 30), "hev1.1.6.L120.B0");
  assert.equal(getCodecParameterString("av1", 1280, 720, 30), "av01.0.08M.08");
  assert.equal(getCodecParameterString("av1", 3840, 2160, 30), "av01.0.09M.08");
  assert.equal(getCodecParameterString("h264", 1280, 720, 30), "avc1.4d0028");
  assert.equal(getCodecParameterString("h264", 1280, 720, 60), "avc1.4d002a");
});

test("MirrorSettings defaults and the playout delay override", () => {
  const s = new MirrorSettings(undefined, {});
  const v = s.getVideoConfig("vp8");
  assert.equal(v.senderSsrc, 11);
  assert.equal(v.receiverSsrc, 12);
  assert.equal(v.rtpTimebase, 90000);
  assert.equal(v.minBitrate, 300_000);
  assert.equal(v.maxBitrate, 5_000_000);
  assert.equal(v.maxFrameRate, 30);
  assert.equal(v.minPlayoutDelayMs, 200);
  const a = s.getAudioConfig("opus");
  assert.equal(a.senderSsrc, 1);
  assert.equal(a.receiverSsrc, 2);
  assert.equal(a.rtpTimebase, 48000);
  assert.equal(a.channels, 2);
  assert.equal(a.maxBitrate, 128_000);
  assert.equal(getPlayoutDelayMs({ CHROME_MIRRORING_PLAYOUT_DELAY: "350" }), 350);
  assert.equal(getPlayoutDelayMs({ CHROME_MIRRORING_PLAYOUT_DELAY: "0" }), 200);
  assert.equal(getPlayoutDelayMs({ CHROME_MIRRORING_PLAYOUT_DELAY: "70000" }), 200);
});

// openscreen_session_host.cc UpdateBandwidthGradualBackoff.

test("gradual backoff: a congested update backs off 15..50%, then recovers quickly", async () => {
  const h = await startHarness({ receiver: {} });
  try {
    await sleep(100);
    // Absorb any frame drops from startup so the baseline count is current, then take the level.
    h.host.updateBandwidthEstimate(1_000_000);
    const start = h.host.currentUsableBandwidth;
    assert.ok(start >= 2_500_000 && start <= 5_000_000);
    h.host.updateBandwidthEstimate(1_000_000);
    assert.equal(h.host.currentUsableBandwidth, start);
    // Force congestion by pretending drops happened.
    const v = h.host.video!;
    (v as unknown as { framesDroppedBeforeEncoding: number }).framesDroppedBeforeEncoding += 1;
    h.host.updateBandwidthEstimate(1_000_000);
    const afterBackoff = h.host.currentUsableBandwidth;
    assert.equal(afterBackoff, Math.trunc(start * 0.5));
    // Clears: fast recovery 1.5x toward the level before backoff.
    h.host.updateBandwidthEstimate(20_000_000);
    assert.equal(h.host.currentUsableBandwidth, Math.min(Math.trunc(afterBackoff * 1.5), 16_000_000));
  } finally {
    h.close();
  }
});

test("stopSession is idempotent and notifies once", async () => {
  const h = await startHarness({ receiver: {} });
  await sleep(200);
  h.host.stopSession();
  h.host.stopSession();
  assert.equal(h.host.isStopped, true);
  assert.equal(h.stopped(), true);
  h.close();
});
