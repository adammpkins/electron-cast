import { test } from "node:test";
import assert from "node:assert/strict";
import { validateStartCasting } from "../../src/electron/manager-api.ts";

test("startCasting arguments: TypeError for a wrong type, RangeError for a wrong value", () => {
  assert.throws(() => validateStartCasting(7, { castMode: "tab_mirror", webContentsId: 1 }), TypeError);
  assert.throws(() => validateStartCasting("", { castMode: "tab_mirror", webContentsId: 1 }), TypeError);
  assert.throws(() => validateStartCasting("s", undefined), TypeError);
  assert.throws(() => validateStartCasting("s", { castMode: "presentation" }), RangeError);
  assert.throws(() => validateStartCasting("s", { castMode: "tab_mirror" }), TypeError);
  assert.throws(() => validateStartCasting("s", { castMode: "tab_mirror", webContentsId: -1 }), RangeError);
  assert.throws(() => validateStartCasting("s", { castMode: "tab_mirror", webContentsId: 1.5 }), RangeError);
  assert.throws(() => validateStartCasting("s", { castMode: "desktop_mirror" }), TypeError);
  assert.throws(() => validateStartCasting("s", { castMode: "desktop_mirror", desktopSourceId: "bogus" }), RangeError);
  assert.throws(() => validateStartCasting("s", { castMode: "desktop_mirror", desktopSourceId: "screen:0:0", withAudio: "yes" }), TypeError);
  assert.throws(() => validateStartCasting("s", { castMode: "tab_mirror", webContentsId: 1, targetPlayoutDelayMs: 0 }), RangeError);
  assert.throws(() => validateStartCasting("s", { castMode: "tab_mirror", webContentsId: 1, targetPlayoutDelayMs: "9" }), TypeError);
  validateStartCasting("s", { castMode: "tab_mirror", webContentsId: 0 });
  validateStartCasting("s", { castMode: "desktop_mirror", desktopSourceId: "screen:0:0", withAudio: true, targetPlayoutDelayMs: 300 });
});

import { SenderPacketRouter } from "../../src/mirroring/sender/packet-router.ts";

test("router: consumes incoming packets with its first sender and drops them after its last", () => {
  const calls: string[] = [];
  const env = {
    now: () => 0,
    sendPacket() {},
    maxPacketSize: 1500,
    schedule: () => () => {},
    consumeIncomingPackets: () => void calls.push("consume"),
    dropIncomingPackets: () => void calls.push("drop"),
  };
  const router = new SenderPacketRouter(env);
  const sender = { streamType: "video" as const, wasLastRtpPacketRetransmission: false, onReceivedRtcpPacket() {}, getRtcpPacketForImmediateSend: () => undefined, getRtpPacketForImmediateSend: () => undefined, getRtpResumeTime: () => Infinity };
  router.onSenderCreated(1, sender);
  router.onSenderCreated(2, sender);
  assert.deepEqual(calls, ["consume"]);
  router.onSenderDestroyed(1);
  assert.deepEqual(calls, ["consume"]);
  router.onSenderDestroyed(2);
  assert.deepEqual(calls, ["consume", "drop"]);
});
