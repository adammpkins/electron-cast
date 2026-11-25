import { test } from "node:test";
import assert from "node:assert/strict";
import { startHarness, startVirtualHarness, sleep } from "./session-harness.ts";

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
  // On a virtual clock: the same run gives the same numbers on any machine, so the bounds can be tight.
  const h = await startVirtualHarness({ receiver: { linkBitsPerSecond: 1_500_000 } });
  try {
    const samples: number[] = [];
    for (let i = 0; i < 12; i++) {
      await h.clock.advance(1000);
      samples.push(h.host.video?.encoderBitrate ?? 0);
    }
    const s = h.receiver.stats;
    console.log(`link 1.5 Mbps (virtual time): video bitrate samples ${samples.join(" ")}, usable ${h.host.currentUsableBandwidth}, dropped by link ${s.packetsDroppedByLink}, video frames ${s.videoFrames}`);
    assert.deepEqual(h.errors, []);
    assert.ok(samples[0]! > 1_000_000, `start ${samples[0]}`);
    const settled = samples.slice(-4);
    // The estimator settles at the link rate: every late reading within 1.2x of it and above a floor, and the end below the start.
    assert.ok(Math.max(...settled) < 1.2 * 1_500_000, `settled ${settled.join(" ")}`);
    assert.ok(Math.min(...settled) > 300_000, `settled ${settled.join(" ")}`);
    assert.ok(settled[settled.length - 1]! < samples[0]!, `start ${samples[0]} end ${settled[settled.length - 1]}`);
    assert.ok(s.videoFrames > 20);
    assert.ok(s.packetsDroppedByLink > 0, "the link did drop packets, so the backoff had a reason");
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

// A receiver that answers every 20 ms or so over a 30 ms and an 80 ms round trip: the in-flight limits (sender.cc
// GetMaxInFlightMediaDuration: 2 x RTT between 81.7 ms and two thirds of the target delay for video, the whole target
// delay for audio) must never trigger on a lossless link.
for (const oneWayDelayMs of [15, 40]) {
  test(`no frame is dropped on a lossless link with a ${oneWayDelayMs * 2} ms round trip`, async () => {
    const h = await startVirtualHarness({ oneWayDelayMs });
    try {
      await h.clock.advance(20_000);
      assert.deepEqual(h.errors, []);
      assert.ok(h.host.video!.framesInserted >= 590);
      assert.deepEqual([...h.host.video!.dropReasons], []);
      assert.deepEqual([...h.host.audio!.dropReasons], []);
    } finally {
      h.close();
    }
  });
}

test("2% packet loss on a 30 ms link costs a few video frames to the in-flight limit, as in Chrome, and no audio", async () => {
  // A lost packet keeps its frame unacknowledged for a NACK round (receiver cadence plus a round trip), long enough
  // for the next frame to find more than the 81.7 ms floor in flight. The limit and its arithmetic are Chromium's.
  let seed = 12345;
  const random = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296;
  const h = await startVirtualHarness({ oneWayDelayMs: 15, receiver: { lossRate: 0.02, random } });
  try {
    await h.clock.advance(20_000);
    const v = h.host.video!;
    assert.deepEqual(h.errors, []);
    const dropped = v.framesDroppedBeforeEncoding + v.framesDroppedAfterEncoding;
    assert.ok(dropped > 0 && dropped < 0.1 * v.framesInserted, `dropped ${dropped} of ${v.framesInserted}`);
    assert.deepEqual([...v.dropReasons.keys()], ["kInFlightDurationTooHigh"]);
    assert.equal(h.host.audio!.framesDropped, 0);
  } finally {
    h.close();
  }
});

test("each stream logs how its feedback arrives every five seconds", async () => {
  const h = await startVirtualHarness({ oneWayDelayMs: 15 });
  try {
    await h.clock.advance(12_000);
    for (const kind of ["audio", "video"]) {
      const lines = h.logs.filter((l) => l.startsWith(`${kind} feedback:`));
      assert.ok(lines.length >= 2, `${kind}: ${lines.length} lines`);
      assert.match(lines[0]!, /packets\/s \(mean gap [\d.]+ ms, max [\d.]+ ms, 0 over 100 ms\), measured round trips: min 3\d(\.\d)? ms, median 3\d(\.\d)? ms, max 3\d(\.\d)? ms, [\d.]+ frames acked\/s \(capture to enqueue: mean [\d.]+ ms, max [\d.]+ ms; capture to ack: mean [\d.]+ ms, max [\d.]+ ms; enqueue to first packet out: mean [\d.]+ ms, max [\d.]+ ms; enqueue to ack: mean [\d.]+ ms, max [\d.]+ ms\), rtt 3\d(\.\d)? ms/);
    }
  } finally {
    h.close();
  }
});

// Chrome's freeze pauses only the video capture device (MirroringMediaControllerHostImpl::Freeze ->
// CastMirroringServiceHost::Pause -> VideoCaptureHost::Pause): the senders, the refresh timer and the audio stream are not
// told. The sender must then go on with RTCP sender reports for both streams and with audio, and resume video cleanly.
test("a long silence on the video stream leaves audio, RTCP sender reports and the in-flight limits as they were", async () => {
  const h = await startVirtualHarness({ oneWayDelayMs: 15 });
  try {
    await h.clock.advance(10_000);
    const s = h.receiver.stats;
    const before = { audio: s.validAudioFrames, videoSr: s.videoSenderReports, audioSr: s.audioSenderReports, video: s.validVideoFrames };
    h.backend.pauseVideoCapture();
    await h.clock.advance(15_000);
    const during = { audio: s.validAudioFrames, videoSr: s.videoSenderReports, audioSr: s.audioSenderReports, video: s.validVideoFrames };
    assert.ok(during.video - before.video <= 3, "no video frames while the capture is paused");
    assert.ok(during.audio - before.audio >= 1450, `audio kept flowing: ${during.audio - before.audio} frames in 15 s`);
    // One report every 500 ms per stream (RTCP_REPORT_INTERVAL), including the video stream with nothing to send.
    assert.ok(during.videoSr - before.videoSr >= 28, `video sender reports: ${during.videoSr - before.videoSr}`);
    assert.ok(during.audioSr - before.audioSr >= 28, `audio sender reports: ${during.audioSr - before.audioSr}`);
    h.backend.resumeVideoCapture(JSON.parse(JSON.stringify(h.backend["lastVideoParams"])), h.backend["videoSink"]!);
    await h.clock.advance(10_000);
    assert.ok(s.validVideoFrames - during.video >= 290, "video resumed");
    assert.deepEqual(h.errors, []);
    assert.deepEqual([...h.host.audio!.dropReasons], []);
    assert.deepEqual([...h.host.video!.dropReasons], []);
  } finally {
    h.close();
  }
});
