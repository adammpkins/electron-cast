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

import { createManagerApi, MediaRouteError, type MediaRoute } from "../../src/electron/manager-api.ts";

test("switchMirroringSourceTab, freezeRoute and unfreezeRoute: argument checks, unknown routes, and the host does the work", () => {
  const route = { id: "r1" } as MediaRoute;
  const calls: string[] = [];
  const mk = (withMirroring: boolean) =>
    createManagerApi({ register: () => () => {}, dispose() {} } as never, {
      mediaRoutes: () => [route],
      observeSessions: () => () => {},
      terminateSession: async () => ({ ok: true, value: null }),
      setSessionVolume: async () => ({ ok: true, value: null }),
      detachSession: () => ({ ok: true, value: null }),
      ...(withMirroring
        ? {
            switchMirroringSourceTab: (id: string, tab: number) => void calls.push(`switch ${id} ${tab}`),
            freezeRoute: (id: string) => (calls.push(`freeze ${id}`), true),
            unfreezeRoute: (id: string) => (calls.push(`unfreeze ${id}`), true),
          }
        : {}),
    } as never, { requests: { observe: () => () => {} }, start: async () => route } as never);
  const api = mk(true);
  api.switchMirroringSourceTab("r1", 4);
  api.freezeRoute("r1");
  api.unfreezeRoute("r1");
  assert.deepEqual(calls, ["switch r1 4", "freeze r1", "unfreeze r1"]);
  assert.throws(() => api.switchMirroringSourceTab("r1", "4" as never), TypeError);
  assert.throws(() => api.switchMirroringSourceTab("r1", -2), RangeError);
  assert.throws(() => api.switchMirroringSourceTab("nope", 4), { code: "route_not_found" });
  assert.throws(() => api.freezeRoute("nope"), { code: "route_not_found" });
  assert.throws(() => api.unfreezeRoute("nope"), MediaRouteError);
  // MediaRouterDebuggerImpl::GetMirroringStats has no error path.
  assert.deepEqual(api.getMirroringStats("nope"), {});
  const without = mk(false);
  assert.throws(() => without.switchMirroringSourceTab("r1", 4), { code: "unable_to_cast" });
  without.freezeRoute("r1");
  api.dispose();
  without.dispose();
});
