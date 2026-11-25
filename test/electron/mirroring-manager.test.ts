// Mirroring through createCastManager: the route runs on the device's one kept-open channel, as Chrome's
// MirroringActivity sends through CastMessageHandler on the sink's CastSocket, and its session is a local activity.
import { test } from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { createCastManager, type IpcMainLike } from "../../src/electron/main.ts";
import { createEncodingSupport } from "../../src/mirroring/encoding-support.ts";
import { createMirroringServiceFactory } from "../../src/mirroring/engine.ts";
import { FakeBackend } from "../mirroring/fake-backend.ts";
import { FakeReceiver } from "../mirroring/fake-receiver.ts";
import { FakeClient, FakeDevices, FAST_SINKS, TV } from "./fakes.ts";

type Listener = (event: any, ...args: any[]) => void;
class FakeIpcMain implements IpcMainLike {
  handlers = new Map<string, (event: any, ...args: any[]) => unknown>();
  handle(channel: string, listener: (event: any, ...args: any[]) => unknown): void {
    this.handlers.set(channel, listener);
  }
  removeHandler(channel: string): void {
    this.handlers.delete(channel);
  }
  on(_channel: string, _listener: Listener): unknown {
    return this;
  }
  removeListener(_channel: string, _listener: Listener): unknown {
    return this;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// the fake receiver listens on loopback, where the stream goes; Chrome's address rule refuses loopback unless allowed
const LOCAL_TV = { ...TV, host: "127.0.0.1", addresses: ["127.0.0.1"] };

test("a mirroring route runs on the device's kept-open channel, is a local route, and ending it leaves the channel open", async () => {
  const receiver = await FakeReceiver.create({ verifyBody: true });
  const clients: FakeClient[] = [];
  const manager = createCastManager({
    ipcMain: new FakeIpcMain(),
    discovery: Object.assign(new FakeDevices([LOCAL_TV]), { async start() {}, stop() {} }),
    sinks: { ...FAST_SINKS, allowAllIps: true },
    createClient: (d) => {
      const c = new FakeClient(d);
      // like CastClient, every status reply is also a receiverStatus event, which the session tracker follows
      c.echoReplies = true;
      const send = c.send.bind(c);
      c.send = (namespace, destinationId, payload) => {
        send(namespace, destinationId, payload);
        if (namespace === "urn:x-cast:com.google.cast.webrtc") setImmediate(() => receiver.onControlMessage(namespace, String(payload)));
      };
      receiver.sendControl = (json) =>
        setImmediate(() => c.emit("message", { namespace: "urn:x-cast:com.google.cast.webrtc", sourceId: c.apps[0]?.transportId ?? "", destinationId: c.senderId, data: json }));
      clients.push(c);
      return c;
    },
    selectDevice: async () => null,
    presentation: false,
    mirroring: {
      createService: createMirroringServiceFactory({
        createBackend: () => new FakeBackend(() => performance.now()),
        encodingSupport: createEncodingSupport({ hardware: new Set(), software: new Set(["vp8"]) }),
        env: {},
      }),
    },
  });
  try {
    await manager.start();
    await manager.settled();
    assert.equal(clients.length, 1, "one channel to the device");
    const channel = clients[0]!;

    const route = await manager.startCasting(TV.id, { castMode: "tab_mirror", webContentsId: 5 });
    assert.equal(clients.length, 1, "mirroring opened no channel of its own");
    assert.ok(channel.calls.includes("launch 0F5096E8"), String(channel.calls));
    assert.equal(route.providerId, "cast");
    assert.equal(route.isLocal, true);
    assert.equal(route.description, "Casting tab");
    assert.deepEqual(route.members, [5]);
    await sleep(600);
    assert.ok(receiver.stats.validVideoFrames > 0, "the receiver got frames");
    // the device reports the streaming session in its status: it is the mirroring route, not a non-local one
    channel.pushStatus();
    assert.deepEqual(manager.getRoutes().map((r) => r.id), [route.id]);

    await manager.terminateRoute(route.id);
    await sleep(50);
    assert.ok(channel.calls.some((c) => c.startsWith("stop ")), String(channel.calls));
    assert.equal(channel.closed, false, "the channel stays open for the device's other sessions");
    assert.deepEqual(manager.getRoutes(), []);
    assert.deepEqual(manager.devices().map((d) => d.id), [TV.id]);
  } finally {
    await manager.dispose();
    receiver.close();
  }
});

// Chrome: `CastActivityManager::OnSessionRemoved` -> `RemoveActivity` drops the activity and sends nothing. Tried on a Nest Hub
// Max, a STOP for the old session sent after our LAUNCH of another app (mirroring to flinging) made the receiver answer that
// launch with LAUNCH_ERROR CANCELLED.
test("a mirroring route the receiver ended sends no STOP and no CLOSE for the session it dropped", async () => {
  const receiver = await FakeReceiver.create({ verifyBody: true });
  const clients: FakeClient[] = [];
  const manager = createCastManager({
    ipcMain: new FakeIpcMain(),
    discovery: Object.assign(new FakeDevices([LOCAL_TV]), { async start() {}, stop() {} }),
    sinks: { ...FAST_SINKS, allowAllIps: true },
    createClient: (d) => {
      const c = new FakeClient(d);
      c.echoReplies = true;
      const send = c.send.bind(c);
      c.send = (namespace, destinationId, payload) => {
        send(namespace, destinationId, payload);
        if (namespace === "urn:x-cast:com.google.cast.webrtc") setImmediate(() => receiver.onControlMessage(namespace, String(payload)));
      };
      receiver.sendControl = (json) =>
        setImmediate(() => c.emit("message", { namespace: "urn:x-cast:com.google.cast.webrtc", sourceId: c.apps[0]?.transportId ?? "", destinationId: c.senderId, data: json }));
      clients.push(c);
      return c;
    },
    selectDevice: async () => null,
    presentation: false,
    mirroring: {
      createService: createMirroringServiceFactory({
        createBackend: () => new FakeBackend(() => performance.now()),
        encodingSupport: createEncodingSupport({ hardware: new Set(), software: new Set(["vp8"]) }),
        env: {},
      }),
    },
  });
  try {
    await manager.start();
    await manager.settled();
    const channel = clients[0]!;
    await manager.startCasting(TV.id, { castMode: "tab_mirror", webContentsId: 5 });
    const before = channel.calls.length;
    // another sender's launch took the receiver's app: the status no longer lists the mirroring session
    channel.apps = [];
    channel.emit("receiverStatus", { applications: [], volume: { ...channel.volume } });
    await sleep(100);
    assert.deepEqual(manager.getRoutes(), [], "the route ended");
    const after = channel.calls.slice(before);
    assert.deepEqual(after.filter((c) => c.startsWith("stop ") || c.startsWith("closeTransport")), [], String(after));
    assert.equal(channel.closed, false, "the channel stays open");
  } finally {
    await manager.dispose();
    receiver.close();
  }
});

test("a mirroring cast mode without the mirroring option is unable_to_cast, and argument errors stay per mode", async () => {
  const manager = createCastManager({
    ipcMain: new FakeIpcMain(),
    discovery: Object.assign(new FakeDevices([TV]), { async start() {}, stop() {} }),
    sinks: FAST_SINKS,
    createClient: (d) => new FakeClient(d),
    selectDevice: async () => null,
  });
  try {
    await assert.rejects(manager.startCasting(TV.id, { castMode: "tab_mirror", webContentsId: 5 }), { code: "unable_to_cast" });
    await assert.rejects(manager.startCasting(TV.id, { castMode: "desktop_mirror", desktopSourceId: "nope" }), RangeError);
    await assert.rejects(manager.startCasting(TV.id, { castMode: "tab_mirror" } as any), TypeError);
    await assert.rejects(manager.startCasting(TV.id, { castMode: "presentation" } as any), TypeError);
  } finally {
    await manager.dispose();
  }
});
