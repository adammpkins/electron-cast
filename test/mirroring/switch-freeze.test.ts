import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { FREEZE_DELAY_MS, type MirroringClient, type MirroringService, type MirroringSessionObserver } from "../../src/mirroring/mirroring-activity.ts";
import { MirroringManager, type MirroringRoute } from "../../src/mirroring/mirroring-manager.ts";
import type { CastDevice } from "../../src/discovery/index.ts";
import { sleep, startHarness } from "./session-harness.ts";

// Chromium: openscreen_session_host.cc SwitchSourceTab, cast_mirroring_service_host.cc SwitchMirroringSourceTab / Pause /
// Resume, mirroring_activity.cc DidGetTabSourceId / Pause / Play, cast_activity_manager.cc OnSourceChanged,
// mirroring_media_controller_host_impl.cc Freeze (kPauseDelay).

test("session host: switching the source tab moves the capture without renegotiating", async () => {
  const h = await startHarness({ receiver: { verifyBody: true } });
  try {
    await sleep(600);
    const offer = h.receiver.lastOffer;
    const before = h.receiver.stats.videoFrames;
    assert.ok(before > 5);
    h.host.switchSourceTab();
    assert.deepEqual(h.backend.events, ["switch-video", "restart-audio"], "video capture host switched, audio device restarted");
    await sleep(600);
    assert.equal(h.receiver.lastOffer, offer, "no new OFFER");
    assert.ok(h.receiver.stats.videoFrames > before + 5, "frames carry on in the same stream");
    assert.equal(h.receiver.stats.invalidFrames, 0);
    assert.deepEqual(h.errors, []);
    assert.equal(h.host.isStopped, false);
  } finally {
    h.close();
  }
});

test("session host: an audio-only session restarts only the audio, and a stopped one ignores the switch", async () => {
  const h = await startHarness({ receiver: {}, type: "audio_only" });
  try {
    await sleep(400);
    h.host.switchSourceTab();
    assert.deepEqual(h.backend.events, ["restart-audio"]);
    h.host.stopSession();
    h.host.switchSourceTab();
    assert.deepEqual(h.backend.events, ["restart-audio"]);
  } finally {
    h.close();
  }
});

// The activity and manager with a stand-in service, so that no media flows.

class FakeClient extends EventEmitter implements MirroringClient {
  readonly senderId = "sender-fake01";
  private readonly sessionId: string;
  constructor(sessionId: string) {
    super();
    this.sessionId = sessionId;
  }
  async connect(): Promise<void> {}
  close(): void {}
  send(): void {}
  async launch(appId: string) {
    return { appId, displayName: "Fake Streaming", sessionId: this.sessionId, transportId: `transport-${this.sessionId}`, namespaces: [] };
  }
  async stop() {
    return { applications: [], volume: {} };
  }
  connectTransport(): void {}
  closeTransport(): void {}
}

interface StubService extends MirroringService {
  observer: MirroringSessionObserver;
  calls: string[];
  failSwitch?: boolean;
}

function device(id: string): CastDevice {
  return { id, name: id, model: "Fake", host: "127.0.0.1", addresses: ["127.0.0.1"], port: 8009, capabilities: 5, isGroup: false, statusText: "", instanceName: id, txt: {} };
}

function stubManager(options: { withoutFreeze?: boolean; terminateRoutesOfPage?: (id: number) => void } = {}) {
  const services: StubService[] = [];
  const manager = new MirroringManager({
    ...(options.terminateRoutesOfPage ? { terminateRoutesOfPage: options.terminateRoutesOfPage } : {}),
    findDevice: (id) => (id.startsWith("dev-") ? device(id) : undefined),
    createClient: (d) => new FakeClient(`sess-${d.id}`),
    createService: (_params, observer) => {
      const calls: string[] = [];
      const service: StubService = {
        observer,
        calls,
        onMessage() {},
        stop() {
          calls.push("stop");
        },
        switchMirroringSourceTab(id) {
          if (service.failSwitch) throw new Error("no such page");
          calls.push(`switch:${id}`);
        },
        ...(options.withoutFreeze
          ? {}
          : {
              pause(cb: () => void) {
                calls.push("pause");
                cb();
              },
              resume(cb: () => void) {
                calls.push("resume");
                cb();
              },
            }),
      };
      services.push(service);
      return service;
    },
  });
  const seen: MirroringRoute[][] = [];
  manager.observe(() => seen.push(manager.routes()));
  return { manager, services, seen };
}

test("switching the source tab keeps the route and its id, and only the page changes", async () => {
  const { manager, services, seen } = stubManager();
  const route = await manager.startMirroring("dev-1", { castMode: "tab_mirror", webContentsId: 5 });
  assert.equal(route.webContentsId, 5);
  const notified = seen.length;
  manager.switchMirroringSourceTab(route.id, 6);
  assert.deepEqual(services[0]!.calls, ["switch:6"]);
  const [after] = manager.routes();
  assert.equal(after!.id, route.id, "same route id");
  assert.equal(after!.mediaSource, route.mediaSource, "Chrome leaves the route's media source as it was");
  assert.equal(after!.sessionId, route.sessionId, "same Cast session");
  assert.equal(after!.webContentsId, 6);
  assert.ok(seen.length > notified, "route observers hear of it");
  assert.equal(services[0]!.calls.includes("stop"), false, "no restart of the service");
  manager.switchMirroringSourceTab(route.id, 6);
  assert.deepEqual(services[0]!.calls, ["switch:6"], "the page that is already the source is a no-op");
  manager.dispose();
});

test("switching to a page another route mirrors terminates that route, and so does starting one on it", async () => {
  const { manager, services } = stubManager();
  const a = await manager.startMirroring("dev-1", { castMode: "tab_mirror", webContentsId: 5 });
  const b = await manager.startMirroring("dev-2", { castMode: "tab_mirror", webContentsId: 6 });
  manager.switchMirroringSourceTab(a.id, 6);
  assert.deepEqual(manager.routes().map((r) => [r.id, r.webContentsId]), [[a.id, 6]], "the route of the new page is gone");
  assert.ok(services[1]!.calls.includes("stop"));
  const c = await manager.startMirroring("dev-3", { castMode: "tab_mirror", webContentsId: 6 });
  assert.deepEqual(manager.routes().map((r) => r.id), [c.id], "one route per page: the earlier one ended");
  assert.equal(b.id === c.id, false);
  manager.dispose();
});

test("switching fails cleanly: unknown route, desktop route, a page that cannot be captured", async () => {
  const { manager, services } = stubManager();
  assert.throws(() => manager.switchMirroringSourceTab("nope", 1), { code: "route_not_found" });
  const desktop = await manager.startMirroring("dev-1", { castMode: "desktop_mirror", desktopSourceId: "screen:0:0", withAudio: true });
  assert.throws(() => manager.switchMirroringSourceTab(desktop.id, 1), { code: "unable_to_cast" });
  const tab = await manager.startMirroring("dev-2", { castMode: "tab_mirror", webContentsId: 5 });
  services[1]!.failSwitch = true;
  assert.throws(() => manager.switchMirroringSourceTab(tab.id, 9), { code: "unable_to_cast", message: "no such page" });
  assert.equal(manager.routes().find((r) => r.id === tab.id)!.webContentsId, 5, "the route is unchanged");
  assert.throws(() => manager.switchMirroringSourceTab(tab.id, -1), TypeError);
  manager.dispose();
});

test("a service that cannot switch refuses", async () => {
  const { manager, services } = stubManager();
  const tab = await manager.startMirroring("dev-1", { castMode: "tab_mirror", webContentsId: 5 });
  delete services[0]!.switchMirroringSourceTab;
  assert.throws(() => manager.switchMirroringSourceTab(tab.id, 6), { code: "unable_to_cast" });
  manager.dispose();
});

test("freezing: not before capture exists, after the 500 ms delay, once for repeated requests, and unfreezing is immediate", async () => {
  assert.equal(FREEZE_DELAY_MS, 500);
  const { manager, services } = stubManager();
  const route = await manager.startMirroring("dev-1", { castMode: "tab_mirror", webContentsId: 5 });
  assert.deepEqual(route.freezeInfo, { canFreeze: false, isFrozen: false });
  manager.freezeRoute(route.id);
  await sleep(FREEZE_DELAY_MS + 100);
  assert.deepEqual(services[0]!.calls, [], "no capture host yet: nothing to pause");

  services[0]!.observer.didStart?.();
  assert.deepEqual(manager.routes()[0]!.freezeInfo, { canFreeze: true, isFrozen: false });
  manager.freezeRoute(route.id);
  manager.freezeRoute(route.id);
  await sleep(FREEZE_DELAY_MS / 2);
  assert.deepEqual(manager.routes()[0]!.freezeInfo, { canFreeze: true, isFrozen: false }, "not yet");
  await sleep(FREEZE_DELAY_MS / 2 + 150);
  assert.deepEqual(services[0]!.calls, ["pause"], "the second request was ignored");
  assert.deepEqual(manager.routes()[0]!.freezeInfo, { canFreeze: true, isFrozen: true });

  manager.unfreezeRoute(route.id);
  assert.deepEqual(services[0]!.calls, ["pause", "resume"]);
  assert.deepEqual(manager.routes()[0]!.freezeInfo, { canFreeze: true, isFrozen: false });
  assert.equal(manager.freezeRoute("not-a-route"), false);
  manager.dispose();
});

test("switching the tab of a frozen route unfreezes it: the new capture is not suspended", async () => {
  const { manager, services } = stubManager();
  const route = await manager.startMirroring("dev-1", { castMode: "tab_mirror", webContentsId: 5 });
  services[0]!.observer.didStart?.();
  manager.freezeRoute(route.id);
  await sleep(FREEZE_DELAY_MS + 150);
  assert.equal(manager.routes()[0]!.freezeInfo.isFrozen, true);
  manager.switchMirroringSourceTab(route.id, 6);
  assert.equal(manager.routes()[0]!.freezeInfo.isFrozen, false);
  manager.dispose();
});

test("a service that cannot pause reports a route that cannot freeze, and ending the route cancels a pending freeze", async () => {
  const none = stubManager({ withoutFreeze: true });
  const a = await none.manager.startMirroring("dev-1", { castMode: "tab_mirror", webContentsId: 5 });
  none.services[0]!.observer.didStart?.();
  assert.deepEqual(none.manager.routes()[0]!.freezeInfo, { canFreeze: false, isFrozen: false });
  none.manager.freezeRoute(a.id);
  none.manager.dispose();

  const { manager, services } = stubManager();
  const route = await manager.startMirroring("dev-1", { castMode: "tab_mirror", webContentsId: 5 });
  services[0]!.observer.didStart?.();
  manager.freezeRoute(route.id);
  manager.terminate(route.id);
  await sleep(FREEZE_DELAY_MS + 100);
  assert.deepEqual(services[0]!.calls, ["stop"], "no pause after the route ended");
  manager.dispose();
});

test("a page that becomes a mirroring source, by a launch or a switch, loses its other routes (routes_by_frame_)", async () => {
  const ended: number[] = [];
  const { manager } = stubManager({ terminateRoutesOfPage: (id) => void ended.push(id) });
  const route = await manager.startMirroring("dev-1", { castMode: "tab_mirror", webContentsId: 5 });
  assert.deepEqual(ended, [5], "launch");
  manager.switchMirroringSourceTab(route.id, 6);
  assert.deepEqual(ended, [5, 6], "switch");
  manager.switchMirroringSourceTab(route.id, 6);
  assert.deepEqual(ended, [5, 6], "no change, no termination");
  await manager.startMirroring("dev-2", { castMode: "desktop_mirror", desktopSourceId: "screen:0:0" });
  assert.deepEqual(ended, [5, 6], "a desktop source belongs to no page");
  // The other direction: a Cast session launched from the mirrored page ends its mirroring route.
  manager.terminateRoutesOfTab(6);
  assert.equal(manager.routes().length, 1);
  assert.equal(manager.routes()[0]!.webContentsId, undefined);
  manager.dispose();
});
