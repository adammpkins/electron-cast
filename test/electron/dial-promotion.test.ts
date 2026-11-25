// A device found by DIAL is tried as a Cast device (CastMediaSinkServiceImpl::OnSinkAddedOrUpdated ->
// TryConnectDialDiscoveredSink -> CreateCastSinkFromDialSink), and one that keeps failing is given up on
// (IsProbablyNonCastDevice). The channels are fakes; nothing here touches a network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCastManager, type IpcMainLike } from "../../src/electron/main.ts";
import { CastSinkService, type ChannelParams } from "../../src/electron/sink-service.ts";
import type { CastDevice } from "../../src/discovery/index.ts";
import { FakeClient, FakeClock, FakeDevices, FAST_SINKS, device, tick } from "./fakes.ts";
import { DEVICE_IP, FakeHttp, SINK_ID, appInfoXml, descriptionXml, ok, ssdpAnswer, DESCRIPTION_URL, APP_URL } from "../dial/fixtures.ts";

const UUID = "aaaa1111222233334444555566667777";
const OTHER_UUID = "bbbb1111222233334444555566667777";

/** A DIAL sink as `DialService.devices()` lists it (`dialSinkToDevice`). */
function dialSink(over: { uuid?: string; ip?: string; name?: string; model?: string } = {}): CastDevice {
  const uuid = over.uuid ?? UUID;
  const ip = over.ip ?? "192.168.1.20";
  return {
    id: `dial:${uuid}`,
    name: over.name ?? "Living Room TV",
    model: over.model ?? "Smart TV",
    host: ip,
    addresses: [ip],
    port: 0,
    capabilities: 0,
    isGroup: false,
    statusText: "",
    instanceName: `dial:${uuid}`,
    txt: {},
    dial: { appUrl: `http://${ip}:8008/apps`, modelName: over.model ?? "Smart TV", ipAddress: ip },
  };
}

/** The DIAL list changing, as the manager's DIAL source reports it. */
class FakeDial extends FakeDevices {
  constructor() {
    super([]);
  }
  set(...sinks: CastDevice[]): void {
    this.list = sinks;
    this.emit("deviceChanged", sinks[0] ?? dialSink());
  }
}

function setup(tweak: (c: FakeClient, p: ChannelParams) => void = () => {}) {
  const source = new FakeDevices([]);
  const dial = new FakeDial();
  const clients: FakeClient[] = [];
  const service = new CastSinkService({
    source,
    dial,
    openDelayMaxMs: 0,
    reportDelayMs: 0,
    retry: { initialDelayMs: 10, jitter: 0, maxAttempts: 3, multiplyFactor: 1 },
    random: () => 0,
    createClient: (d, p) => {
      const c = new FakeClient(d);
      clients.push(c);
      tweak(c, p);
      return c;
    },
  });
  return { source, dial, service, clients };
}

function timed(body: (clock: FakeClock) => Promise<void>): () => Promise<void> {
  return async () => {
    const clock = new FakeClock().install();
    try {
      await body(clock);
    } finally {
      clock.restore();
    }
  };
}

const refuse = (c: FakeClient): void => {
  c.connectError = new Error("connection refused");
};

const dialFailures = (service: CastSinkService): Map<string, number> =>
  (service as unknown as { dialFailureCounts: Map<string, number> }).dialFailureCounts;

test("a DIAL sink is opened on port 8009 and becomes a Cast sink with its name and model, and audio and video capabilities", timed(async (clock) => {
  const { dial, service, clients } = setup();
  const opened: CastDevice[] = [];
  service.on("channelOpened", ({ device: d }) => opened.push(d));
  dial.set(dialSink());
  await clock.advance(10);
  assert.equal(clients.length, 1);
  assert.deepEqual([clients[0]!.device.host, clients[0]!.device.port], ["192.168.1.20", 8009]);
  const sink = service.sinks()[0]!;
  assert.deepEqual(
    { id: sink.id, name: sink.name, model: sink.model, host: sink.host, port: sink.port, capabilities: sink.capabilities, isGroup: sink.isGroup, dial: sink.dial },
    { id: UUID, name: "Living Room TV", model: "Smart TV", host: "192.168.1.20", port: 8009, capabilities: 5, isGroup: false, dial: undefined },
  );
  assert.equal(opened.length, 1);
  assert.deepEqual(service.devices().map((d) => d.id), [UUID], "reported like any sink");
  service.dispose();
}));

test("a device whose certificate restricts it to audio is an audio sink", timed(async (clock) => {
  const { dial, service } = setup((c) => {
    Object.defineProperty(c, "deviceAuth", { value: { policy: "audio_only" } });
  });
  dial.set(dialSink());
  await clock.advance(10);
  assert.equal(service.sinks()[0]?.capabilities, 4);
  service.dispose();
}));

test("the channel gets Chrome's usual open parameters", timed(async (clock) => {
  const seen: ChannelParams[] = [];
  const { dial, service } = setup((_c, p) => seen.push(p));
  dial.set(dialSink());
  await clock.advance(10);
  assert.deepEqual(seen, [{ connectTimeoutMs: 10_000, livenessTimeoutMs: 10_000, pingIntervalMs: 5000 }]);
  service.dispose();
}));

test("only a new or changed DIAL sink is tried, as AddOrUpdateSink notifies only those", timed(async (clock) => {
  const { dial, service, clients } = setup(refuse);
  dial.set(dialSink());
  await clock.advance(1000);
  assert.equal(clients.length, 3, "one run of attempts");
  dial.set(dialSink());
  await clock.advance(1000);
  assert.equal(clients.length, 3, "the same list again is no news");
  dial.set(dialSink({ name: "Renamed TV" }));
  await clock.advance(1000);
  assert.equal(clients.length, 6, "a changed sink is tried again");
  service.dispose();
}));

test("a failed attempt is retried by the backoff like any channel, and the sink is never listed", timed(async (clock) => {
  const { dial, service, clients } = setup(refuse);
  const failures: boolean[] = [];
  service.on("openFailed", (_d, _e, willRetry) => failures.push(willRetry));
  dial.set(dialSink());
  await clock.advance(5);
  assert.equal(clients.length, 1);
  await clock.advance(10);
  assert.equal(clients.length, 2, "the second attempt follows the 10 ms backoff");
  await clock.advance(1000);
  assert.deepEqual(failures, [true, true, false]);
  assert.deepEqual(service.sinks(), []);
  service.dispose();
}));

test("no channel is opened when a Cast sink already has the DIAL sink's id", timed(async (clock) => {
  const { source, dial, service, clients } = setup();
  source.up(device({ id: UUID, host: "192.168.1.20", addresses: ["192.168.1.20"] }));
  await clock.advance(10);
  assert.equal(clients.length, 1);
  dial.set(dialSink({ ip: "192.168.1.99" }));
  await clock.advance(10);
  assert.equal(clients.length, 1, "the id is enough, whatever the address");
  service.dispose();
}));

test("no channel is opened when a Cast sink already has the DIAL sink's address", timed(async (clock) => {
  const { source, dial, service, clients } = setup();
  source.up(device({ id: "some-other-id", host: "192.168.1.20", addresses: ["192.168.1.20"] }));
  await clock.advance(10);
  assert.equal(clients.length, 1);
  dial.set(dialSink());
  await clock.advance(10);
  assert.equal(clients.length, 1, "a second channel would be redundant");
  assert.deepEqual(service.sinks().map((d) => d.id), ["some-other-id"]);
  service.dispose();
}));

test("mDNS finding a promoted device does not replace its channel, and the Cast sink then has what mDNS says of it", timed(async (clock) => {
  const { source, dial, service, clients } = setup();
  dial.set(dialSink());
  await clock.advance(10);
  assert.equal(clients.length, 1);
  source.up(device({ id: UUID, name: "Name from mDNS", model: "Chromecast", host: "192.168.1.20", addresses: ["192.168.1.20"], capabilities: 5 }));
  await clock.advance(10);
  assert.equal(clients.length, 1, "the endpoint is the same, so the channel stays");
  assert.equal(service.sinks()[0]?.name, "Name from mDNS");
  service.dispose();
}));

test("discoverSinksNow tries the DIAL sinks again, with no change event needed", timed(async (clock) => {
  const { dial, service, clients } = setup(refuse);
  dial.list = [dialSink()];
  service.discoverSinksNow();
  await clock.advance(5);
  assert.equal(clients.length, 1);
  service.dispose();
}));

test("after ten failed attempts a DIAL device is taken for a non-Cast device and no more are made", timed(async (clock) => {
  const { dial, service, clients } = setup(refuse);
  dial.set(dialSink());
  // Every attempt counts, and the count is looked at only when a run begins: runs of 3 take it to 3, 6, 9 and 12.
  for (const total of [3, 6, 9, 12]) {
    await clock.advance(1000);
    assert.equal(clients.length, total);
    service.discoverSinksNow();
  }
  await clock.advance(1000);
  assert.equal(clients.length, 12, "12 >= 10: left alone");
  dial.set(dialSink({ name: "Renamed TV" }));
  await clock.advance(1000);
  assert.equal(clients.length, 12, "also when the sink changes");
  service.dispose();
}));

test("nine failed attempts are not enough", timed(async (clock) => {
  const { dial, service, clients } = setup(refuse);
  dial.set(dialSink());
  for (const total of [3, 6, 9]) {
    await clock.advance(1000);
    assert.equal(clients.length, total);
    service.discoverSinksNow();
  }
  await clock.advance(1000);
  assert.equal(clients.length, 12, "the count was 9 when the fourth run began");
  service.dispose();
}));

test("each device has its own count", timed(async (clock) => {
  const { dial, service, clients } = setup(refuse);
  dial.set(dialSink(), dialSink({ uuid: OTHER_UUID, ip: "192.168.1.21" }));
  for (let i = 0; i < 3; i++) {
    await clock.advance(1000);
    service.discoverSinksNow();
  }
  await clock.advance(1000);
  assert.equal(clients.length, 24, "four runs of three attempts for each");
  service.discoverSinksNow();
  await clock.advance(1000);
  assert.equal(clients.length, 24, "both are given up on");
  service.dispose();
}));

test("opening the device for any other reason resets the count, even when that fails too", timed(async (clock) => {
  const { source, dial, service, clients } = setup(refuse);
  dial.set(dialSink());
  for (let i = 0; i < 4; i++) {
    await clock.advance(1000);
    service.discoverSinksNow();
  }
  await clock.advance(1000);
  assert.equal(clients.length, 12);
  assert.equal(dialFailures(service).get(UUID), 12);
  // mDNS finds the device: opening its channel (it fails) shows the device to be a Cast device
  source.up(device({ id: UUID, host: "192.168.1.20", addresses: ["192.168.1.20"] }));
  await clock.advance(1000);
  assert.equal(clients.length, 15, "three attempts from mDNS");
  assert.equal(dialFailures(service).has(UUID), false);
  service.dispose();
}));

test("a network change resets the count", timed(async (clock) => {
  const { dial, service, clients } = setup(refuse);
  dial.set(dialSink());
  for (let i = 0; i < 4; i++) {
    await clock.advance(1000);
    service.discoverSinksNow();
  }
  await clock.advance(1000);
  assert.equal(clients.length, 12);
  service.networkChanged();
  service.discoverSinksNow();
  await clock.advance(1000);
  assert.equal(clients.length, 15);
  service.dispose();
}));

test("a DIAL attempt that succeeds does not clear the count of failures", timed(async (clock) => {
  let fail = true;
  const { dial, service, clients } = setup((c) => {
    if (fail) refuse(c);
  });
  dial.set(dialSink());
  for (let i = 0; i < 2; i++) {
    await clock.advance(1000);
    service.discoverSinksNow();
  }
  await clock.advance(1000);
  assert.equal(clients.length, 9);
  fail = false;
  service.discoverSinksNow();
  await clock.advance(1000);
  assert.equal(service.sinks().length, 1, "the next run opens");
  assert.equal(dialFailures(service).get(UUID), 9);
  service.dispose();
}));

test("an address that may not be opened to is skipped and not counted", timed(async (clock) => {
  const { dial, service, clients } = setup();
  const skipped: string[] = [];
  service.on("skipped", (_d, reason) => skipped.push(reason));
  const warn = console.warn;
  console.warn = () => {};
  try {
    dial.set(dialSink({ ip: "8.8.8.8" }));
    await clock.advance(10);
  } finally {
    console.warn = warn;
  }
  assert.equal(clients.length, 0);
  assert.equal(skipped.length, 1);
  assert.equal(dialFailures(service).size, 0);
  service.dispose();
}));

test("disposing stops listening to DIAL, and a service with no DIAL source ignores the DIAL calls", timed(async (clock) => {
  const { dial, service, clients } = setup();
  service.dispose();
  dial.set(dialSink());
  await clock.advance(10);
  assert.equal(clients.length, 0);
  const plain = new CastSinkService({ source: new FakeDevices([]), createClient: (d) => new FakeClient(d) });
  plain.discoverSinksNow();
  plain.networkChanged();
  plain.dispose();
}));

// Through the manager: the DIAL sink is hidden once the Cast sink is listed.

class Ipc implements IpcMainLike {
  handle(): void {}
  removeHandler(): void {}
  on(): unknown {
    return this;
  }
  removeListener(): unknown {
    return this;
  }
}

class FakeDiscovery extends FakeDevices {
  async start(): Promise<void> {}
  stop(): void {}
}

async function manager(castable: boolean) {
  const http = new FakeHttp()
    .reply("GET", DESCRIPTION_URL, ok(descriptionXml(), { "application-url": `${APP_URL}/` }))
    .reply("GET", `${APP_URL}/YouTube`, ok(appInfoXml("stopped")));
  const clients: FakeClient[] = [];
  const m = createCastManager({
    ipcMain: new Ipc(),
    discovery: new FakeDiscovery([]),
    sinks: FAST_SINKS,
    createClient: (d) => {
      const c = new FakeClient(d);
      if (!castable) refuse(c);
      clients.push(c);
      return c;
    },
    selectDevice: async () => null,
    dial: {
      http,
      settleMs: 5,
      registry: {
        interfaces: () => [{ name: "lo", address: "127.0.0.1" }],
        openSocket: async (_iface, handlers) => ({
          send() {
            queueMicrotask(() => handlers.message(Buffer.from(ssdpAnswer(), "latin1"), { address: DEVICE_IP, port: 1900 }));
          },
          close() {},
        }),
        requestIntervalMs: 5,
        responseTimeoutMs: 20,
        maxRequests: 1,
      },
    },
  });
  await m.start();
  await tick(100);
  await m.settled();
  await tick(50);
  return { m, clients };
}

test("through the manager, a DIAL device with a Cast channel is listed as a Cast sink only", async () => {
  const { m, clients } = await manager(true);
  const seen: any[][] = [];
  const stop = m.registerMediaSinksObserver({ onSinksUpdated: (s) => seen.push(s) });
  const sinks = seen.at(-1)!;
  assert.equal(clients.length, 1);
  assert.equal(clients[0]!.device.port, 8009);
  assert.deepEqual(sinks.map((s) => [s.id, s.providerId, s.iconType, s.name, s.description]), [[UUID, "cast", "cast", "Living Room TV", "Smart TV"]]);
  assert.equal(sinks.some((s) => s.id === SINK_ID), false, "the DIAL sink is hidden");
  assert.deepEqual(m.devices().map((d) => d.id), [UUID]);
  stop();
  await m.dispose();
});

test("through the manager, a DIAL device that is no Cast device stays a DIAL sink", async () => {
  const { m } = await manager(false);
  const seen: any[][] = [];
  const stop = m.registerMediaSinksObserver({ onSinksUpdated: (s) => seen.push(s) });
  assert.deepEqual(seen.at(-1)!.map((s) => [s.id, s.providerId]), [[SINK_ID, "dial"]]);
  assert.deepEqual(m.devices(), []);
  stop();
  await m.dispose();
});
