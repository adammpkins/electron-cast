// The sink service follows Chrome's CastMediaSinkServiceImpl (see docs/DESIGN.md): a device is a sink only once a channel
// to it has opened and authenticated, failed attempts are retried with BackoffEntry's delays, and mDNS forgetting a device
// does not drop an open channel.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CastSinkService, isLoopback, isPubliclyRoutable } from "../../src/electron/sink-service.ts";
import { CastAuthError } from "../../src/client/errors.ts";
import { FakeClient, FakeDevices, TV, SPEAKER, GROUP, device, tick } from "./fakes.ts";
import type { CastDevice } from "../../src/discovery/index.ts";

function setup(over: Partial<ConstructorParameters<typeof CastSinkService>[0]> = {}, tweak: (c: FakeClient) => void = () => {}) {
  const source = new FakeDevices([]);
  const clients: FakeClient[] = [];
  const times: number[] = [];
  const service = new CastSinkService({
    source,
    openDelayMaxMs: 0,
    reportDelayMs: 0,
    retry: { initialDelayMs: 10, jitter: 0, maxAttempts: 3, multiplyFactor: 2 },
    random: () => 0,
    createClient: (d: CastDevice) => {
      const c = new FakeClient(d);
      clients.push(c);
      times.push(Date.now());
      tweak(c);
      return c;
    },
    ...over,
  });
  return { source, service, clients, times };
}

test("a device is a sink only after its channel opens, and the list is reported once it settles", async () => {
  const { source, service } = setup({ reportDelayMs: 40 }, (c) => { c.connectDelayMs = 10; });
  const ups: string[] = [];
  service.on("deviceUp", (d) => ups.push(d.id));
  source.up(TV);
  source.up(SPEAKER);
  await tick(2);
  assert.deepEqual(service.sinks(), [], "the channels are still opening");
  await tick(25);
  assert.deepEqual(service.sinks().map((d) => d.id), ["dev-tv", "dev-speaker"], "known as sinks once open");
  assert.deepEqual(service.devices(), [], "but not reported until discovery has been quiet for the report delay");
  await service.settled();
  assert.deepEqual(ups, ["dev-tv", "dev-speaker"]);
  assert.deepEqual(service.devices().map((d) => d.id), ["dev-tv", "dev-speaker"]);
  service.dispose();
});

test("a device that fails device authentication never appears and is tried the configured number of times", async () => {
  const { source, service, clients } = setup({}, (c) => { c.connectError = new CastAuthError("invalid_certificate", "not signed by Google"); });
  const failures: boolean[] = [];
  service.on("openFailed", (_d, _e, willRetry) => failures.push(willRetry));
  const removed: string[] = [];
  service.on("sinkRemoved", (d) => removed.push(d.id));
  source.up(TV);
  await tick(80);
  assert.equal(clients.length, 3);
  assert.deepEqual(failures, [true, true, false]);
  assert.deepEqual(service.devices(), []);
  assert.deepEqual(service.sinks(), []);
  assert.deepEqual(removed, [], "it was never a sink to remove");
  assert.ok(clients.every((c) => c.closed), "every failed attempt's socket is closed");
  service.dispose();
});

test("retries wait out BackoffEntry's growing delay, and a later success lists the device", async () => {
  let attempt = 0;
  const { source, service, times } = setup(
    { retry: { initialDelayMs: 30, jitter: 0, maxAttempts: 5, multiplyFactor: 2, maxDelayMs: 1000 } },
    (c) => { if (++attempt < 3) c.connectError = new Error("ECONNREFUSED"); },
  );
  source.up(TV);
  await tick(200);
  await service.settled();
  assert.equal(times.length, 3);
  const [g1, g2] = [times[1]! - times[0]!, times[2]! - times[1]!];
  assert.ok(g1 >= 25 && g1 < 55, `first wait about 30 ms, was ${g1}`);
  assert.ok(g2 >= 55 && g2 < 100, `second wait about 60 ms, was ${g2}`);
  assert.deepEqual(service.devices().map((d) => d.id), ["dev-tv"]);
  service.dispose();
});

test("the backoff is cut by up to the jitter and capped at the maximum", async () => {
  const waits: number[] = [];
  const realSet = globalThis.setTimeout;
  const { source, service } = setup({
    retry: { initialDelayMs: 100, jitter: 0.5, maxAttempts: 4, multiplyFactor: 3, maxDelayMs: 150 },
    random: () => 1,
  }, (c) => { c.connectError = new Error("no"); });
  (globalThis as any).setTimeout = (fn: () => void, ms?: number, ...rest: unknown[]) => {
    if (ms !== undefined && ms >= 40) waits.push(ms);
    return realSet(fn, 0, ...rest);
  };
  try {
    source.up(TV);
    await new Promise((r) => realSet(r, 60));
  } finally {
    globalThis.setTimeout = realSet;
  }
  // failure 1: 100 - 0.5 * 100 = 50; failure 2: 300 - 150 = 150; failure 3: 900 - 450 = 450, capped at 150
  assert.deepEqual(waits, [50, 150, 150]);
  service.dispose();
});

test("an open channel that fails is reopened; a sink that cannot be reopened is removed from the list", async () => {
  let down = false;
  const { source, service, clients } = setup({}, (c) => { if (down) c.connectError = new Error("EHOSTUNREACH"); });
  const log: string[] = [];
  service.on("deviceDown", (d) => log.push(`down ${d.id}`));
  service.on("channelClosed", () => log.push("closed"));
  service.on("sinkRemoved", () => log.push("removed"));
  source.up(TV);
  await service.settled();
  await tick(5);
  assert.equal(clients.length, 1);
  clients[0]!.fail();
  await service.settled();
  assert.equal(clients.length, 2, "reopened right away");
  assert.deepEqual(service.devices().map((d) => d.id), ["dev-tv"], "the sink stays listed while it is reopened");
  down = true;
  clients[1]!.fail();
  await tick(100);
  await service.settled();
  assert.deepEqual(service.devices(), []);
  assert.deepEqual(log, ["closed", "closed", "removed", "down dev-tv"]);
  service.dispose();
});

test("mDNS forgetting a device does not close its open channel", async () => {
  const { source, service, clients } = setup();
  source.up(TV);
  await service.settled();
  await tick(5);
  source.down(TV);
  await tick(10);
  assert.deepEqual(service.devices().map((d) => d.id), ["dev-tv"]);
  assert.equal(clients[0]!.closed, false);
  service.dispose();
});

test("a device whose address changed gets a new channel and the old one is closed", async () => {
  const { source, service, clients } = setup();
  source.up(TV);
  await service.settled();
  await tick(5);
  const moved = { ...TV, host: "10.0.0.99", addresses: ["10.0.0.99"] };
  source.list = [moved];
  source.emit("deviceChanged", moved);
  await tick(5);
  await service.settled();
  assert.equal(clients.length, 2);
  assert.equal(clients[0]!.closed, true);
  assert.equal(service.clientOf(TV.id), clients[1]);
  assert.equal(service.sinks().length, 1);
  service.dispose();
});

test("two ids at one address are one sink: the newer replaces the older", async () => {
  const { source, service } = setup();
  source.up(TV);
  await service.settled();
  await tick(5);
  source.up({ ...TV, id: "dev-tv-renamed" });
  await tick(5);
  await service.settled();
  assert.deepEqual(service.sinks().map((d) => d.id), ["dev-tv-renamed"]);
  service.dispose();
});

test("publicly routable and loopback addresses are skipped unless allowAllIps is set (kMediaRouterCastAllowAllIPs)", async () => {
  const publicTv = device({ id: "pub", host: "8.8.8.8", addresses: ["8.8.8.8"] });
  const loop = device({ id: "loop", host: "127.0.0.1", addresses: ["127.0.0.1"] });
  const strict = setup();
  strict.source.list = [publicTv, loop, GROUP];
  strict.source.emit("deviceUp", publicTv);
  await tick(5);
  await strict.service.settled();
  assert.deepEqual(strict.service.sinks().map((d) => d.id), ["dev-group"]);
  strict.service.dispose();

  const lax = setup({ allowAllIps: true });
  lax.source.list = [publicTv, loop];
  lax.source.emit("deviceUp", publicTv);
  await tick(5);
  await lax.service.settled();
  assert.deepEqual(lax.service.sinks().map((d) => d.id).sort(), ["loop", "pub"]);
  lax.service.dispose();
});

test("isPubliclyRoutable and isLoopback follow net/base/ip_address.cc", () => {
  for (const h of ["10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.1.1", "100.64.0.1", "127.0.0.1", "fe80::1", "fd00::1", "::1"]) {
    assert.equal(isPubliclyRoutable(h), false, h);
  }
  for (const h of ["8.8.8.8", "172.32.0.1", "1.1.1.1", "2001:4860:4860::8888", "::ffff:8.8.8.8", "printer.local"]) {
    assert.equal(isPubliclyRoutable(h), true, h);
  }
  assert.equal(isLoopback("127.5.5.5"), true);
  assert.equal(isLoopback("::1"), true);
  assert.equal(isLoopback("10.0.0.1"), false);
});

test("discoverSinksNow opens channels at once, including for a device that gave up", async () => {
  let fail = true;
  const { source, service, clients } = setup({ openDelayMaxMs: 10_000, retry: { initialDelayMs: 5, jitter: 0, maxAttempts: 1 } }, (c) => { if (fail) c.connectError = new Error("no"); });
  source.list = [TV];
  service.discoverSinksNow();
  await tick(10);
  assert.equal(clients.length, 1);
  assert.deepEqual(service.sinks(), []);
  fail = false;
  service.discoverSinksNow();
  await tick(5);
  assert.deepEqual(service.sinks().map((d) => d.id), ["dev-tv"]);
  service.dispose();
});

test("dispose closes every channel, stops pending work and silences events", async () => {
  const { source, service, clients } = setup();
  source.up(TV);
  source.up(SPEAKER);
  await service.settled();
  await tick(5);
  let events = 0;
  service.on("deviceUp", () => events++);
  service.on("deviceDown", () => events++);
  source.up(GROUP);
  service.dispose();
  await tick(20);
  assert.ok(clients.every((c) => c.closed));
  assert.equal(events, 0);
  assert.deepEqual(service.sinks(), []);
  assert.equal(source.listenerCount("deviceUp"), 0);
  service.dispose();
});
