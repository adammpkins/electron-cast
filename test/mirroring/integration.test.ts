import { test } from "node:test";
import assert from "node:assert/strict";
import { startHarness, sleep } from "./session-harness.ts";

/**
 * The whole sender (session host, senders, router, UDP) against the fake receiver over localhost UDP.
 * Nothing here talks to a real Cast device.
 */

test("a session negotiates, streams VP8 and Opus, and the receiver decrypts and validates every frame", async () => {
  const h = await startHarness({ receiver: { verifyBody: true } });
  try {
    await sleep(2500);
    const s = h.receiver.stats;
    const seconds = ((s.lastFrameAt ?? 0) - (s.firstFrameAt ?? 0)) / 1000;
    const fps = s.videoFrames / seconds;
    const kbps = Math.round((s.videoBytes * 8) / seconds / 1000);
    console.log(`clean: ${s.videoFrames} video frames (${fps.toFixed(1)} fps, ${kbps} kbps), ${s.audioFrames} audio frames, key frames ${s.videoKeyFrames}`);
    assert.deepEqual(h.errors, []);
    assert.ok(s.videoFrames >= 50, `video frames ${s.videoFrames}`);
    assert.ok(s.audioFrames >= 150, `audio frames ${s.audioFrames}`);
    assert.equal(s.invalidFrames, 0);
    assert.equal(s.validVideoFrames, s.videoFrames);
    assert.equal(s.validAudioFrames, s.audioFrames);
    assert.ok(s.videoKeyFrames >= 1);
    assert.ok(fps > 15 && fps < 35, `fps ${fps}`);
  } finally {
    h.close();
  }
});

test("lost packets are NACKed and retransmitted, and every frame still decrypts", async () => {
  let seed = 12345;
  const random = (): number => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const h = await startHarness({ receiver: { verifyBody: true, lossRate: 0.05, random } });
  try {
    await sleep(3000);
    const s = h.receiver.stats;
    console.log(`loss 5%: dropped ${s.packetsDroppedByLoss} of ${s.packetsReceived} packets, NACKed ${s.nackedPackets}, retransmissions received ${s.retransmissionsReceived}, video ${s.videoFrames} frames, audio ${s.audioFrames} frames`);
    assert.deepEqual(h.errors, []);
    assert.ok(s.packetsDroppedByLoss > 20);
    assert.ok(s.nackedPackets > 0);
    assert.ok(s.retransmissionsReceived > 0);
    assert.equal(s.invalidFrames, 0);
    // Without retransmission about 1 - 0.95^n of the multi-packet frames would be lost; with it nearly all arrive.
    assert.ok(s.videoFrames >= 45, `video frames ${s.videoFrames}`);
    assert.ok(s.audioFrames >= 150, `audio frames ${s.audioFrames}`);
  } finally {
    h.close();
  }
});

test("the video bitrate backs off when the link cannot carry it", async () => {
  const h = await startHarness({ receiver: { linkBitsPerSecond: 1_500_000 } });
  try {
    // Sampled once a second rather than read once at the end: wall-clock timers make a single reading noisy, the
    // trend is not.
    const samples: number[] = [];
    for (let i = 0; i < 8; i++) {
      await sleep(1000);
      samples.push(h.host.video?.encoderBitrate ?? 0);
    }
    const early = samples[0]!;
    const settled = samples.slice(-3);
    const late = settled[settled.length - 1]!;
    const s = h.receiver.stats;
    console.log(`link 1.5 Mbps: video bitrate samples ${samples.join(" ")}, usable ${h.host.currentUsableBandwidth}, dropped by link ${s.packetsDroppedByLink}, video frames ${s.videoFrames}`);
    assert.deepEqual(h.errors, []);
    assert.ok(early > 1_000_000, `early ${early}`);
    // The estimator settles near the link rate: the median late reading within 1.35x of it (1.2x when the machine is idle; the suite runs files in parallel, and a reading may overshoot
    // while the estimator probes upward), none beyond 1.6x, and the end below the start.
    const median = [...settled].sort((x, y) => x - y)[1]!;
    assert.ok(median < 1.35 * 1_500_000, `settled ${settled.join(" ")}`);
    assert.ok(Math.max(...settled) < 1.6 * 1_500_000, `settled ${settled.join(" ")}`);
    assert.ok(Math.min(...settled) > 300_000, `settled ${settled.join(" ")}`);
    assert.ok(late < early, `early ${early} late ${late}`);
    assert.ok(s.videoFrames > 20);
  } finally {
    h.close();
  }
});

test("the session stops with ANSWER_TIME_OUT when no ANSWER arrives", async () => {
  const h = await startHarness({ receiver: {} });
  h.receiver.sendControl = () => {};
  // Replace the answer path: nothing is delivered, so the 4 s reply timeout fires.
  try {
    await sleep(4300);
    assert.equal(h.stopped(), true);
    assert.equal(h.errors[0]?.error, "ANSWER_TIME_OUT");
  } finally {
    h.close();
  }
});

test("an audio-only session offers just Opus", async () => {
  const h = await startHarness({ type: "audio_only", receiver: {} });
  try {
    await sleep(800);
    assert.deepEqual(h.errors, []);
    assert.equal(h.receiver.stats.videoFrames, 0);
    assert.ok(h.receiver.stats.audioFrames > 30);
    const streams = (h.receiver.lastOffer!.offer as { supportedStreams: { type: string }[] }).supportedStreams;
    assert.deepEqual(streams.map((s) => s.type), ["audio_source"]);
  } finally {
    h.close();
  }
});
