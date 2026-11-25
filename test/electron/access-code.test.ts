// Adding a device by address follows Chrome's AccessCodeCastSinkService once the discovery server has answered (see
// docs/DESIGN.md, "Access code casting"). Timing runs on a fake clock, so nothing waits in real time.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CastSinkService, type ChannelParams } from "../../src/electron/sink-service.ts";
import {
  AccessCodeCastDisabledError, AccessCodeSinks, createAccessCodeSink,
  type AccessCodeDevice, type AccessCodeOptions, type AccessCodeRoute, type AccessCodeStore,
} from "../../src/electron/access-code.ts";
import { CastSessionService } from "../../src/electron/session-service.ts";
import { FakeClient, FakeClock, FakeDevices, FAST_SINKS, tick } from "./fakes.ts";
import type { CastDevice } from "../../src/discovery/index.ts";

const WALL = { id: "a1b2c3d4e5f60718293a4b5c6d7e8f90", name: "Seminar Room 4", capabilities: { videoOut: true, audioOut: true }, ipV4Address: "10.20.30.40" };

/** The sink id of a device id: Chrome's `cast:<%s>` without the scheme electron-cast's ids leave out. */
const sinkOf = (id: string): string => `<${id}>`;
const SINK = sinkOf(WALL.id);

const entry = (over: Partial<AccessCodeDevice> = {}): AccessCodeDevice => ({ ...WALL, ...over });

class FakeRoutes {
  list: AccessCodeRoute[] = [];
  private readonly listeners = new Set<() => void>();
  current(): AccessCodeRoute[] {
    return this.list.map((r) => ({ ...r }));
  }
  observe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }
  set(list: AccessCodeRoute[]): void {
    this.list = list;
    for (const l of [...this.listeners]) l();
  }
}

class MemoryStore implements AccessCodeStore {
  saved: unknown[];
  saves = 0;
  constructor(initial: unknown[] = []) {
    this.saved = initial;
  }
  load(): unknown[] {
    return this.saved;
  }
  save(sinks: unknown[]): void {
    this.saved = JSON.parse(JSON.stringify(sinks)) as unknown[];
    this.saves += 1;
  }
}

function setup(clock: FakeClock, over: { options?: AccessCodeOptions; tweak?: (c: FakeClient, p: ChannelParams) => void; allowAllIps?: boolean } = {}) {
  const source = new FakeDevices([]);
  const clients: FakeClient[] = [];
  const params: ChannelParams[] = [];
  const sinks = new CastSinkService({
    source,
    ...FAST_SINKS,
    retry: { initialDelayMs: 10, jitter: 0, maxAttempts: 3, multiplyFactor: 1 },
    random: () => 0,
    allowAllIps: over.allowAllIps,
    createClient: (d: CastDevice, p: ChannelParams) => {
      const c = new FakeClient(d);
      clients.push(c);
      params.push(p);
      over.tweak?.(c, p);
      return c;
    },
  });
  const routes = new FakeRoutes();
  const store = new MemoryStore();
  const access = new AccessCodeSinks(sinks, routes, { enabled: true, store, now: () => clock.now, ...over.options });
  return { source, sinks, routes, store, access, clients, params };
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

test("a device from the server is checked as CreateAccessCodeMediaSink checks it, in its order", () => {
  const ok = createAccessCodeSink(entry({ id: "uuid:A1B2C3D4-E5F6-0718-293A-4B5C6D7E8F90", port: "8010" }));
  assert.ok(ok.ok);
  assert.deepEqual(ok.device, {
    id: SINK, name: "Seminar Room 4", model: "Chromecast Cast Moderator", host: "10.20.30.40",
    addresses: ["10.20.30.40"], port: 8010, capabilities: 1 | 4, isGroup: false, statusText: "", instanceName: "", txt: {},
  }, "the id is processed like an mDNS id, the model name is Chrome's, capabilities are the ca bits");

  const both = createAccessCodeSink(entry({ ipV6Address: "FD00:0:0:0:0:0:0:5", ipV4Address: "10.20.30.40" }));
  assert.ok(both.ok);
  assert.equal(both.device.host, "fd00::5", "IPv6 is preferred, in canonical form");
  const fallback = createAccessCodeSink(entry({ ipV6Address: "not an address" }));
  assert.ok(fallback.ok);
  assert.equal(fallback.device.host, "10.20.30.40", "an invalid IPv6 address falls back to the IPv4 one");

  const reason = (e: unknown): string => {
    const r = createAccessCodeSink(e);
    assert.equal(r.ok, false);
    return r.ok ? "" : r.result.code === "sink_creation_error" ? r.result.reason : r.result.code;
  };
  assert.equal(reason(entry({ ipV4Address: undefined })), "missing_or_invalid_ip_address");
  assert.equal(reason(entry({ ipV4Address: "fe80::1%eth0" })), "missing_or_invalid_ip_address", "no zone ids: net::IPAddress rejects them");
  assert.equal(reason(entry({ ipV4Address: "10.20.30.040" })), "missing_or_invalid_ip_address");
  assert.equal(reason(entry({ ipV4Address: "wall.example.edu" })), "missing_or_invalid_ip_address", "a host name is not an IP address");
  assert.equal(reason(entry({ id: "" })), "missing_id");
  assert.equal(reason(entry({ name: "" })), "missing_friendly_name");
  assert.equal(reason(entry({ id: "", name: "", ipV4Address: undefined })), "missing_or_invalid_ip_address", "the IP address is checked first, then id, name, port");
  assert.equal(reason(entry({ id: "", name: "", port: "x" })), "missing_id");
  for (const port of ["x", "8009x", "65536", "-1", "1.5", 70000, 1.5, " 8009"]) {
    assert.equal(reason(entry({ port })), "missing_or_invalid_port", String(port));
  }
  assert.equal(reason(null), "response_malformed");
  assert.equal(reason(entry({ id: 7 as unknown as string })), "response_malformed");
  assert.equal(reason(entry({ name: undefined as unknown as string })), "response_malformed");
  assert.equal(reason(entry({ capabilities: undefined as unknown as object })), "response_malformed");
  assert.equal(reason(entry({ capabilities: { videoOut: "yes" } as never })), "response_malformed", "a capability that is there must be a bool");

  const port = (p: AccessCodeDevice["port"]) => {
    const r = createAccessCodeSink(entry({ port: p }));
    assert.ok(r.ok);
    return r.device.port;
  };
  assert.equal(port(undefined), 8009, "kCastControlPort when the server sends none");
  assert.equal(port(""), 8009);
  assert.equal(port("+8010"), 8010);
  assert.equal(port(0), 0, "net::IsPortValid accepts 0, so does this (a channel to it then fails)");
  assert.equal(port(65535), 65535);
  const allCaps = createAccessCodeSink(entry({ capabilities: { videoOut: true, videoIn: true, audioOut: true, audioIn: true, devMode: true } }));
  assert.ok(allCaps.ok);
  assert.equal(allCaps.device.capabilities, 31);
  const none = createAccessCodeSink(entry({ capabilities: {} }));
  assert.ok(none.ok);
  assert.equal(none.device.capabilities, 0);
});

test("nothing can be added until access code casting is enabled, as Chrome's factory makes no service otherwise", timed(async (clock) => {
  const { access, sinks, clients } = setup(clock, { options: { enabled: false } });
  await assert.rejects(access.addSinkByAddress(entry()), AccessCodeCastDisabledError);
  assert.equal(clients.length, 0);
  await access.configure({ enabled: true });
  assert.equal((await access.addSinkByAddress(entry())).code, "ok");
  assert.equal(sinks.sinks().length, 1);
  access.dispose();
  sinks.dispose();
}));

test("an added device gets a channel with Chrome's quick open params, is listed, and is remembered", timed(async (clock) => {
  const { access, sinks, params, store } = setup(clock, { options: { deviceDuration: 3600 } });
  const result = await access.addSinkByAddress(entry());
  assert.deepEqual(result, { code: "ok", sinkId: SINK });
  assert.deepEqual(params, [{ connectTimeoutMs: 2000, livenessTimeoutMs: 8000, pingIntervalMs: 4000 }], "CreateCastSocketOpenParams: 2 s, 8 s, ping 4 s");
  await clock.advance(1);
  assert.deepEqual(sinks.devices().map((d) => [d.id, d.name, d.host, d.port, d.model]), [[SINK, "Seminar Room 4", "10.20.30.40", 8009, "Chromecast Cast Moderator"]]);
  assert.deepEqual(store.saved, [{ id: SINK, name: "Seminar Room 4", ip: "10.20.30.40", port: 8009, capabilities: 5, model: "Chromecast Cast Moderator", addedAt: 0 }]);
  assert.deepEqual(access.remembered().map((r) => r.id), [SINK]);
  access.dispose();
  sinks.dispose();
}));

test("a device that cannot be reached fails quickly: three attempts a second apart, then channel_open_error and nothing kept", timed(async (clock) => {
  const { access, sinks, clients, store } = setup(clock, { tweak: (c) => { c.connectError = new Error("ECONNREFUSED"); } });
  const pending = access.addSinkByAddress(entry());
  const out: { result?: Awaited<typeof pending> } = {};
  void pending.then((r) => { out.result = r; });
  const outcome = (): typeof out.result => out.result;
  await clock.advance(0);
  assert.equal(clients.length, 1);
  assert.equal(outcome(), undefined, "still retrying");
  await clock.advance(1000);
  assert.equal(clients.length, 2, "one second after the first failure: the policy's 1 s with no growth");
  await clock.advance(1000);
  assert.equal(clients.length, 3);
  assert.equal(outcome()?.code, "channel_open_error", "RetryParams::max_retry_attempts is 3");
  assert.deepEqual(sinks.sinks(), []);
  assert.deepEqual(store.saved, []);
  assert.equal(access.remembered().length, 0);
  access.dispose();
  sinks.dispose();
}));

test("the address rules of discovered devices apply: a public or loopback address is refused unless allowed", timed(async (clock) => {
  const refused = setup(clock);
  const warn = console.warn;
  console.warn = () => {};
  try {
    for (const ip of ["8.8.8.8", "127.0.0.1", "2001:4860:4860::8888"]) {
      const r = await refused.access.addSinkByAddress(entry({ ipV4Address: ip.includes(":") ? undefined : ip, ipV6Address: ip.includes(":") ? ip : undefined }));
      assert.equal(r.code, "channel_open_error", ip);
    }
  } finally {
    console.warn = warn;
  }
  assert.equal(refused.clients.length, 0);
  refused.access.dispose();
  refused.sinks.dispose();
  const allowed = setup(clock, { allowAllIps: true });
  assert.equal((await allowed.access.addSinkByAddress(entry({ ipV4Address: "8.8.8.8" }))).code, "ok");
  allowed.access.dispose();
  allowed.sinks.dispose();
}));

test("an IPv4-mapped IPv6 address is judged by the IPv4 address in it, as Chrome does", timed(async (clock) => {
  const refused = setup(clock);
  const warn = console.warn;
  console.warn = () => {};
  try {
    for (const ip of ["::ffff:8.8.8.8", "::ffff:808:808", "0:0:0:0:0:ffff:808:808"]) {
      const r = await refused.access.addSinkByAddress(entry({ ipV4Address: undefined, ipV6Address: ip }));
      assert.equal(r.code, "channel_open_error", ip);
    }
  } finally {
    console.warn = warn;
  }
  assert.equal(refused.clients.length, 0, "no connection is made to a public address");
  // a mapped private address is allowed, and so is a mapped loopback one: IsLoopback does not look into it, and
  // IsPubliclyRoutable says no for 127/8
  const ok = await refused.access.addSinkByAddress(entry({ ipV4Address: undefined, ipV6Address: "::ffff:192.168.1.5" }));
  assert.equal(ok.code, "ok");
  const loop = await refused.access.addSinkByAddress(entry({ id: "dddddddddddddddddddddddddddddddd", ipV4Address: undefined, ipV6Address: "::ffff:127.0.0.1" }));
  assert.equal(loop.code, "ok");
  assert.equal(refused.clients.length, 2);
  refused.access.dispose();
  refused.sinks.dispose();
}));

test("a sink that is not this service's is refreshed but never remembered or expired by it", timed(async (clock) => {
  const { access, sinks, source, store } = setup(clock);
  // a sink found by discovery whose id happens to equal the one this service would use
  source.up({ id: SINK, name: "Found by mDNS", model: "Chromecast", host: "10.20.30.40", addresses: ["10.20.30.40"], port: 8009, capabilities: 5, isGroup: false, statusText: "", instanceName: "x", txt: {} });
  await clock.advance(1);
  assert.equal(sinks.sinks().length, 1);
  const r = await access.addSinkByAddress(entry({ name: "Typed in" }));
  assert.deepEqual(r, { code: "ok", sinkId: SINK });
  await clock.advance(1);
  assert.equal(sinks.sinks()[0]?.name, "Typed in", "its name is refreshed");
  assert.deepEqual(store.saved, [], "nothing is remembered");
  await clock.advance(120_000);
  assert.equal(sinks.sinks().length, 1, "and no timer removes it");
  access.dispose();
  sinks.dispose();
}));

test("a device found by mDNS and added by address is two sinks until the same-address rule removes one, as in Chrome", timed(async (clock) => {
  const { access, sinks, source } = setup(clock, { options: { deviceDuration: 3600 } });
  source.up({ id: WALL.id, name: "Found by mDNS", model: "Chromecast", host: "10.20.30.40", addresses: ["10.20.30.40"], port: 8009, capabilities: 5, isGroup: false, statusText: "", instanceName: "x", txt: {} });
  await clock.advance(1);
  assert.deepEqual(sinks.sinks().map((d) => d.id), [WALL.id]);
  assert.equal((await access.addSinkByAddress(entry())).code, "ok");
  await clock.advance(1);
  assert.deepEqual(sinks.sinks().map((d) => d.id), [SINK], "one sink per address: the newer replaces the mDNS one");
  access.dispose();
  sinks.dispose();
}));

test("a malformed or incomplete device is refused before any channel is opened", timed(async (clock) => {
  const { access, sinks, clients } = setup(clock);
  const bad = await access.addSinkByAddress(entry({ port: "http" }));
  assert.equal(bad.code, "sink_creation_error");
  assert.equal(bad.code === "sink_creation_error" && bad.reason, "missing_or_invalid_port");
  assert.equal((await access.addSinkByAddress("nope" as never)).code, "response_malformed");
  assert.equal(clients.length, 0);
  access.dispose();
  sinks.dispose();
}));

test("with the default duration of 0 the device stays 20 s so a route can be made, then goes", timed(async (clock) => {
  const { access, sinks, store, clients } = setup(clock);
  await access.addSinkByAddress(entry());
  await clock.advance(1);
  assert.equal(sinks.sinks().length, 1);
  await clock.advance(19_000);
  assert.equal(sinks.sinks().length, 1, "kExpirationTimerDelay is 20 s");
  assert.equal(access.remembered().length, 1);
  await clock.advance(1000);
  assert.deepEqual(access.remembered(), [], "forgotten when the timer fires");
  assert.deepEqual(store.saved, []);
  assert.equal(sinks.sinks().length, 1, "removed from the list 450 ms later (kExpirationDelay)");
  await clock.advance(450);
  assert.deepEqual(sinks.sinks(), []);
  assert.equal(clients[0]?.closed, true, "and its channel is closed");
  access.dispose();
  sinks.dispose();
}));

test("a longer duration keeps the device that long, counted from when it was added, plus the 20 s", timed(async (clock) => {
  const { access, sinks } = setup(clock, { options: { deviceDuration: 100 } });
  await access.addSinkByAddress(entry());
  await clock.advance(119_000);
  assert.equal(sinks.sinks().length, 1);
  await clock.advance(1000 + 450);
  assert.deepEqual(sinks.sinks(), []);
  access.dispose();
  sinks.dispose();
}));

test("a device a page is casting to is kept past its time, and goes 450 ms after the route ends", timed(async (clock) => {
  const { access, sinks, routes } = setup(clock);
  await access.addSinkByAddress(entry());
  await clock.advance(1);
  routes.set([{ id: "route-1", sinkId: SINK, isLocal: true }]);
  await clock.advance(60_000);
  assert.equal(sinks.sinks().length, 1, "OnExpiration waits for a local route to end");
  assert.equal(access.remembered().length, 1, "and the device is still remembered");
  routes.set([]);
  await clock.advance(449);
  assert.equal(sinks.sinks().length, 1, "after a pause, in case another route starts at once");
  await clock.advance(1);
  assert.deepEqual(access.remembered(), [], "its time is up, so the check expires it now");
  await clock.advance(450);
  assert.deepEqual(sinks.sinks(), []);
  access.dispose();
  sinks.dispose();
}));

test("a route that ends and is replaced straight away does not expire the device", timed(async (clock) => {
  const { access, sinks, routes } = setup(clock);
  await access.addSinkByAddress(entry());
  routes.set([{ id: "route-1", sinkId: SINK, isLocal: true }]);
  await clock.advance(60_000);
  routes.set([]);
  await clock.advance(100);
  routes.set([{ id: "route-2", sinkId: SINK, isLocal: true }]);
  await clock.advance(5000);
  assert.equal(sinks.sinks().length, 1);
  assert.equal(access.remembered().length, 1);
  access.dispose();
  sinks.dispose();
}));

test("a route that ends before the duration has passed leaves the device listed", timed(async (clock) => {
  const { access, sinks, routes } = setup(clock, { options: { deviceDuration: 3600 } });
  await access.addSinkByAddress(entry());
  routes.set([{ id: "route-1", sinkId: SINK, isLocal: true }]);
  await clock.advance(5000);
  routes.set([]);
  await clock.advance(5000);
  assert.equal(sinks.sinks().length, 1, "DoCheckMediaSinkForExpiration returns when time is left");
  assert.equal(access.remembered().length, 1);
  access.dispose();
  sinks.dispose();
}));

test("a route that is not this app's does not keep the device past its time", timed(async (clock) => {
  const { access, sinks, routes } = setup(clock);
  await access.addSinkByAddress(entry());
  routes.set([{ id: "route-1", sinkId: SINK, isLocal: false }]);
  await clock.advance(21_000);
  assert.deepEqual(access.remembered(), [], "OnExpiration waits only for local routes");
  await clock.advance(450);
  assert.deepEqual(sinks.sinks(), [], "RemoveAndDisconnectMediaSinkFromRouter spares a sink with a local route only");
  access.dispose();
  sinks.dispose();
}));

test("entering a code again for a listed device opens no channel, refreshes its name and capabilities, and restarts its time", timed(async (clock) => {
  const { access, sinks, clients, store } = setup(clock, { options: { deviceDuration: 100 } });
  await access.addSinkByAddress(entry());
  await clock.advance(50_000);
  const again = await access.addSinkByAddress(entry({ name: "Seminar Room 4 (new)", capabilities: { audioOut: true }, ipV4Address: "10.20.30.41" }));
  assert.deepEqual(again, { code: "ok", sinkId: SINK });
  assert.equal(clients.length, 1, "HasSink: the channel is kept");
  await clock.advance(1);
  const [d] = sinks.devices();
  assert.deepEqual([d?.name, d?.capabilities, d?.host], ["Seminar Room 4 (new)", 4, "10.20.30.40"], "UpdateExistingSink changes the name and capabilities, not the endpoint");
  assert.deepEqual(store.saved.map((e) => (e as { ip: string; addedAt: number }).ip), ["10.20.30.41"], "the store gets the new data");
  await clock.advance(119_000);
  assert.equal(sinks.sinks().length, 1, "50 s + 100 s + 20 s");
  await clock.advance(1000 + 450);
  assert.deepEqual(sinks.sinks(), []);
  access.dispose();
  sinks.dispose();
}));

test("one device is not remembered twice under two ids at one address", timed(async (clock) => {
  const { access, sinks, store } = setup(clock, { options: { deviceDuration: 3600 } });
  await access.addSinkByAddress(entry());
  await access.addSinkByAddress(entry({ id: "ffffffffffffffffffffffffffffffff", name: "Renamed" }));
  await clock.advance(1);
  assert.deepEqual(store.saved.map((e) => (e as { id: string }).id), [sinkOf("ffffffffffffffffffffffffffffffff")], "UpdateDevicesDict removes the entry with the same IP endpoint");
  assert.deepEqual(sinks.sinks().map((d) => d.id), [sinkOf("ffffffffffffffffffffffffffffffff")], "and the sink service keeps one sink per address");
  access.dispose();
  sinks.dispose();
}));

test("remembered devices are read back when the service starts, validated, and tried with the sink service's own params", timed(async (clock) => {
  const source = new FakeDevices([]);
  const params: ChannelParams[] = [];
  const sinks = new CastSinkService({
    source, ...FAST_SINKS, random: () => 0,
    createClient: (d, p) => {
      params.push(p);
      return new FakeClient(d);
    },
  });
  const good = { id: "aaaa", name: "Lobby", ip: "10.1.1.1", port: 8009, capabilities: 5, model: "Chromecast Cast Moderator", addedAt: 0 };
  const store = new MemoryStore([
    good,
    { ...good, id: "bad-ip", ip: "wall.example" },
    { ...good, id: "bad-port", port: "8009" },
    { ...good, id: "no-time", ip: "10.1.1.2", addedAt: undefined },
    "junk",
  ]);
  const access = new AccessCodeSinks(sinks, new FakeRoutes(), { enabled: true, deviceDuration: 3600, store, now: () => clock.now });
  await access.ready();
  await clock.advance(1);
  assert.deepEqual(access.remembered().map((r) => r.id), ["aaaa", "no-time"], "an entry that does not validate is dropped (ValidateStoredDevices)");
  assert.deepEqual((store.saved as { id: string }[]).map((r) => r.id), ["aaaa", "no-time"], "and dropped from the store");
  assert.deepEqual(sinks.sinks().map((d) => d.id), ["aaaa", "no-time"]);
  assert.deepEqual(params.map((p) => p.connectTimeoutMs), [10_000, 10_000], "a remembered device gets the usual open params");
  await clock.advance(20_000);
  assert.deepEqual(access.remembered().map((r) => r.id), ["aaaa"], "an entry with no addition time expires at once (plus the 20 s)");
  access.dispose();
  sinks.dispose();
}));

test("turning access code casting off removes the devices and forgets them; a new duration restarts the timers", timed(async (clock) => {
  const { access, sinks, store } = setup(clock, { options: { deviceDuration: 100 } });
  await access.addSinkByAddress(entry());
  await clock.advance(10_000);
  await access.configure({ deviceDuration: 5 });
  // the time left (none: 5 s after the addition is past) plus 20 s, from the change
  await clock.advance(19_999);
  assert.equal(access.remembered().length, 1, "OnDurationPrefChange sets every timer again, each with its 20 s");
  await clock.advance(1);
  assert.deepEqual(access.remembered(), []);
  await access.addSinkByAddress(entry({ id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", ipV4Address: "10.20.30.50" }));
  await access.configure({ enabled: false });
  assert.deepEqual(access.remembered(), []);
  assert.deepEqual(store.saved, []);
  await clock.advance(450);
  assert.deepEqual(sinks.sinks(), []);
  await assert.rejects(access.addSinkByAddress(entry()), AccessCodeCastDisabledError);
  access.dispose();
  sinks.dispose();
}));

test("when the network changes, devices with no route leave and the remembered ones are tried again 4.45 s on", timed(async (clock) => {
  const { access, sinks, routes } = setup(clock, { options: { deviceDuration: 3600 } });
  await access.addSinkByAddress(entry());
  await access.addSinkByAddress(entry({ id: "cccccccccccccccccccccccccccccccc", name: "In use", ipV4Address: "10.20.30.60" }));
  routes.set([{ id: "r", sinkId: sinkOf("cccccccccccccccccccccccccccccccc"), isLocal: true }]);
  await clock.advance(1);
  access.onNetworksChanged("network-b");
  await clock.advance(450);
  assert.deepEqual(sinks.sinks().map((d) => d.id), [sinkOf("cccccccccccccccccccccccccccccccc")], "a device in use stays");
  assert.equal(access.remembered().length, 2, "and nothing is forgotten");
  await clock.advance(4000);
  assert.deepEqual(sinks.sinks().map((d) => d.id).sort(), [SINK, sinkOf("cccccccccccccccccccccccccccccccc")].sort(), "remembered devices are added again");
  access.dispose();
  sinks.dispose();
}));

test("disposing while a channel is being opened ends the add", timed(async (clock) => {
  const { access, sinks } = setup(clock, { tweak: (c) => { c.connectDelayMs = 500; } });
  const pending = access.addSinkByAddress(entry());
  await clock.advance(10);
  sinks.dispose();
  assert.equal((await pending).code, "channel_open_error");
  access.dispose();
}));

test("the service adds a device by address, lists it, and keeps it for the routes it has", async () => {
  const devices = new FakeDevices([]);
  const clients: FakeClient[] = [];
  const service = new CastSessionService({
    devices,
    sinks: FAST_SINKS,
    accessCode: { enabled: true, deviceDuration: 3600 },
    createClient: (d) => {
      const c = new FakeClient(d);
      clients.push(c);
      return c;
    },
    selectDevice: async () => null,
    emit: () => {},
  });
  try {
    await assert.rejects(new CastSessionService({ devices, createClient: (d) => new FakeClient(d), selectDevice: async () => null, emit: () => {} }).addSinkByAddress(entry()), AccessCodeCastDisabledError);
    const result = await service.addSinkByAddress(entry({ ipV4Address: "10.20.30.40", port: "8009" }));
    assert.equal(result.code, "ok");
    await tick(5);
    assert.deepEqual(service.devices().map((d) => d.name), ["Seminar Room 4"], "a page's picker and availability see it like a discovered device");
    assert.equal(service.rememberedSinks().length, 1);
    assert.equal(clients.length, 1);
  } finally {
    await service.dispose();
  }
});
