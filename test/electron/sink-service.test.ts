// The sink service follows Chrome's CastMediaSinkServiceImpl (see docs/DESIGN.md): a device is a sink only once a channel
// to it has opened and authenticated, failed attempts are retried with BackoffEntry's delays, and mDNS forgetting a device
// does not drop an open channel. Tests of timing run on a fake clock, so nothing waits in real time.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CastSinkService, isLoopback, isPubliclyRoutable, type ChannelParams } from "../../src/electron/sink-service.ts";
import { CastAuthError } from "../../src/client/errors.ts";
import { FakeClient, FakeClock, FakeDevices, TV, SPEAKER, GROUP, device } from "./fakes.ts";
import type { CastDevice } from "../../src/discovery/index.ts";

function setup(
  over: Partial<ConstructorParameters<typeof CastSinkService>[0]> = {},
  tweak: (c: FakeClient, params: ChannelParams) => void = () => {},
) {
  const source = new FakeDevices([]);
  const clients: FakeClient[] = [];
  const params: ChannelParams[] = [];
  const service = new CastSinkService({
    source,
    openDelayMaxMs: 0,
    reportDelayMs: 0,
    retry: { initialDelayMs: 10, jitter: 0, maxAttempts: 3, multiplyFactor: 2 },
    random: () => 0,
    createClient: (d: CastDevice, p: ChannelParams) => {
      const c = new FakeClient(d);
      clients.push(c);
      params.push(p);
      tweak(c, p);
      return c;
    },
    ...over,
  });
  return { source, service, clients, params };
}

/** Run a test on a fake clock that is always put back. */
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

test("a device is a sink only after its channel opens, and the list is reported once discovery has been quiet", timed(async (clock) => {
  const { source, service } = setup({ reportDelayMs: 40 }, (c) => { c.connectDelayMs = 10; });
  const ups: string[] = [];
  service.on("deviceUp", (d) => ups.push(d.id));
  source.up(TV);
  source.up(SPEAKER);
  await clock.advance(5);
  assert.deepEqual(service.sinks(), [], "the channels are still opening");
  await clock.advance(10);
  assert.deepEqual(service.sinks().map((d) => d.id), ["dev-tv", "dev-speaker"], "known as sinks once open");
  assert.deepEqual(service.devices(), [], "but not reported until the report delay has passed");
  await clock.advance(34);
  assert.deepEqual(service.devices(), []);
  await clock.advance(1);
  assert.deepEqual(ups, ["dev-tv", "dev-speaker"]);
  assert.deepEqual(service.devices().map((d) => d.id), ["dev-tv", "dev-speaker"]);
  service.dispose();
}));

test("a device that fails device authentication never appears and is tried the configured number of times", timed(async (clock) => {
  const { source, service, clients } = setup({}, (c) => { c.connectError = new CastAuthError("invalid_certificate", "not signed by Google"); });
  const failures: boolean[] = [];
  service.on("openFailed", (_d, _e, willRetry) => failures.push(willRetry));
  const removed: string[] = [];
  service.on("sinkRemoved", (d) => removed.push(d.id));
  source.up(TV);
  await clock.advance(1000);
  assert.equal(clients.length, 3);
  assert.deepEqual(failures, [true, true, false]);
  assert.deepEqual(service.devices(), []);
  assert.deepEqual(service.sinks(), []);
  assert.deepEqual(removed, [], "it was never a sink to remove");
  assert.ok(clients.every((c) => c.closed), "every failed attempt's socket is closed");
  service.dispose();
}));

test("retries wait out BackoffEntry's growing delay, and a later success lists the device", timed(async (clock) => {
  let attempt = 0;
  const { source, service, clients } = setup(
    { retry: { initialDelayMs: 30, jitter: 0, maxAttempts: 5, multiplyFactor: 2, maxDelayMs: 1000 } },
    (c) => { if (++attempt < 3) c.connectError = new Error("ECONNREFUSED"); },
  );
  source.up(TV);
  await clock.advance(1);
  assert.equal(clients.length, 1);
  await clock.advance(28);
  assert.equal(clients.length, 1, "the first retry waits 30 ms");
  await clock.advance(1);
  assert.equal(clients.length, 2);
  await clock.advance(59);
  assert.equal(clients.length, 2, "the second waits 60 ms");
  await clock.advance(1);
  assert.equal(clients.length, 3);
  assert.deepEqual(service.devices().map((d) => d.id), ["dev-tv"]);
  service.dispose();
}));

test("the backoff is cut by up to the jitter and capped at the maximum", timed(async (clock) => {
  const { source, service } = setup({
    retry: { initialDelayMs: 100, jitter: 0.5, maxAttempts: 4, multiplyFactor: 3, maxDelayMs: 150 },
    random: () => 1,
  }, (c) => { c.connectError = new Error("no"); });
  source.up(TV);
  await clock.advance(1000);
  // failure 1: 100 - 0.5 * 100 = 50; failure 2: 300 - 150 = 150; failure 3: 900 - 450 = 450, capped at 150
  assert.deepEqual(clock.delays.filter((d) => d >= 40), [50, 150, 150]);
  service.dispose();
}));

test("an open channel that fails is reopened; a sink that cannot be reopened is removed from the list", timed(async (clock) => {
  let down = false;
  const { source, service, clients } = setup({}, (c) => { if (down) c.connectError = new Error("EHOSTUNREACH"); });
  const log: string[] = [];
  service.on("deviceDown", (d) => log.push(`down ${d.id}`));
  service.on("channelClosed", () => log.push("closed"));
  service.on("sinkRemoved", () => log.push("removed"));
  source.up(TV);
  await clock.advance(1);
  assert.equal(clients.length, 1);
  clients[0]!.fail();
  await clock.advance(1);
  assert.equal(clients.length, 2, "reopened right away");
  assert.deepEqual(service.devices().map((d) => d.id), ["dev-tv"], "the sink stays listed while it is reopened");
  down = true;
  clients[1]!.fail();
  await clock.advance(1000);
  assert.deepEqual(service.devices(), []);
  assert.deepEqual(log, ["closed", "closed", "removed", "down dev-tv"]);
  service.dispose();
}));

test("connect and liveness timeouts are 10 s, and grow by the delta per failure up to 30 s and 60 s when one is set", timed(async (clock) => {
  const plain = setup({ retry: { initialDelayMs: 10, jitter: 0, maxAttempts: 4 } }, (c) => { c.connectError = new Error("no"); });
  plain.source.up(TV);
  await clock.advance(1000);
  assert.deepEqual(plain.params.map((p) => p.connectTimeoutMs), [10000, 10000, 10000, 10000], "Chrome's delta is 0");
  plain.service.dispose();

  const growing = setup({ dynamicTimeoutDeltaMs: 8000, retry: { initialDelayMs: 10, jitter: 0, maxAttempts: 5 } }, (c) => { c.connectError = new Error("no"); });
  growing.source.up(TV);
  await clock.advance(1000);
  assert.deepEqual(growing.params.map((p) => p.connectTimeoutMs), [10000, 10000, 10000, 10000, 10000], "one run keeps the parameters it began with");
  // the next run (a rediscovery) starts from the failures so far
  growing.service.discoverSinksNow();
  await clock.advance(1);
  assert.equal(growing.params.at(-1)?.connectTimeoutMs, 30000, "10 s + 5 * 8 s, capped at 30 s");
  assert.equal(growing.params.at(-1)?.livenessTimeoutMs, 50000, "10 s + 5 * 8 s, below the 60 s cap");
  growing.service.dispose();
}));

test("the timeouts go back to 10 s once the device opens", timed(async (clock) => {
  let fail = true;
  const { source, service, params, clients } = setup({ dynamicTimeoutDeltaMs: 4000, retry: { initialDelayMs: 10, jitter: 0, maxAttempts: 1 } }, (c) => { if (fail) c.connectError = new Error("no"); });
  source.up(TV);
  await clock.advance(1);
  fail = false;
  service.discoverSinksNow();
  await clock.advance(1);
  assert.equal(params.at(-1)?.connectTimeoutMs, 14000, "one failure so far");
  assert.equal(service.sinks().length, 1);
  clients.at(-1)!.fail();
  await clock.advance(1);
  assert.equal(params.at(-1)?.connectTimeoutMs, 10000, "the failure count was cleared by the success");
  service.dispose();
}));

test("mDNS forgetting a device does not close its open channel", async () => {
  const { source, service, clients } = setup();
  source.up(TV);
  await service.settled();
  source.down(TV);
  await service.settled();
  assert.deepEqual(service.devices().map((d) => d.id), ["dev-tv"]);
  assert.equal(clients[0]!.closed, false);
  service.dispose();
});

test("a device whose address changed gets a new channel and the old one is closed once nothing uses it", async () => {
  let inUse = true;
  const { source, service, clients } = setup({ isClientInUse: () => inUse });
  const retired: unknown[] = [];
  service.on("channelRetired", (c) => retired.push(c));
  source.up(TV);
  await service.settled();
  const moved = { ...TV, host: "10.0.0.99", addresses: ["10.0.0.99"] };
  source.list = [moved];
  source.emit("deviceChanged", moved);
  await service.settled();
  assert.equal(clients.length, 2);
  assert.equal(service.clientOf(TV.id), clients[1]);
  assert.deepEqual(retired, [clients[0]]);
  assert.equal(clients[0]!.closed, false, "a session may still be using it: Chrome leaves the old socket alone");
  service.releaseUnused();
  assert.equal(clients[0]!.closed, false, "still in use");
  inUse = false;
  service.releaseUnused();
  assert.equal(clients[0]!.closed, true);
  assert.equal(service.sinks().length, 1);
  service.dispose();
});

test("a replaced channel that nothing uses is closed at once, and dispose closes the ones still in use", async () => {
  const { source, service, clients } = setup({ isClientInUse: (c) => c === clients[0] });
  source.up(TV);
  await service.settled();
  source.list = [{ ...TV, host: "10.0.0.98", addresses: ["10.0.0.98"] }];
  source.emit("deviceChanged", source.list[0]!);
  await service.settled();
  assert.equal(clients[0]!.closed, false);
  source.list = [{ ...TV, host: "10.0.0.97", addresses: ["10.0.0.97"] }];
  source.emit("deviceChanged", source.list[0]!);
  await service.settled();
  assert.equal(clients[1]!.closed, true, "the second one was not in use");
  service.dispose();
  assert.ok(clients.every((c) => c.closed));
});

test("a device's addresses reordered by mDNS do not replace a channel that works", async () => {
  const { source, service, clients } = setup();
  const two = { ...TV, host: "10.0.0.10", addresses: ["10.0.0.10", "10.0.0.11"] };
  source.list = [two];
  source.emit("deviceUp", two);
  await service.settled();
  assert.equal(clients.length, 1);
  const reordered = { ...two, host: "10.0.0.11", addresses: ["10.0.0.11", "10.0.0.10"], name: "Renamed" };
  source.list = [reordered];
  source.emit("deviceChanged", reordered);
  await service.settled();
  assert.equal(clients.length, 1, "no new channel");
  assert.equal(clients[0]!.closed, false);
  assert.equal(service.sinkOf(TV.id)?.host, "10.0.0.10", "the endpoint in use is kept");
  assert.equal(service.sinkOf(TV.id)?.name, "Renamed", "while the sink's other details are updated");
  // and after the channel fails it is reopened at the endpoint that worked
  clients[0]!.fail();
  await service.settled();
  assert.equal(clients.length, 2);
  assert.equal(service.sinkOf(TV.id)?.host, "10.0.0.10");
  service.dispose();
});

test("a stale retry for an endpoint the device has left does not undo a channel opened at the new one", timed(async (clock) => {
  const { source, service, clients } = setup(
    { retry: { initialDelayMs: 50, jitter: 0, maxAttempts: 3, multiplyFactor: 1 } },
    (c) => { if (c.device.host === "10.0.0.10") c.connectError = new Error("refused"); },
  );
  source.up(TV);
  await clock.advance(1);
  assert.equal(clients.length, 1, "the old address failed and a retry is waiting");
  const moved = { ...TV, host: "10.0.0.99", addresses: ["10.0.0.99"] };
  source.list = [moved];
  source.emit("deviceChanged", moved);
  await clock.advance(1);
  assert.equal(service.clientOf(TV.id), clients[1], "opened at the new address");
  await clock.advance(200);
  assert.equal(clients.length, 2, "the old address is not tried again");
  assert.equal(service.sinkOf(TV.id)?.host, "10.0.0.99");
  assert.equal(clients[1]!.closed, false);
  service.dispose();
}));

test("two ids at one address are one sink: the newer replaces the older", async () => {
  const { source, service } = setup();
  source.up(TV);
  await service.settled();
  source.up({ ...TV, id: "dev-tv-renamed" });
  await service.settled();
  assert.deepEqual(service.sinks().map((d) => d.id), ["dev-tv-renamed"]);
  service.dispose();
});

test("publicly routable and loopback addresses are skipped unless allowAllIps is set (kMediaRouterCastAllowAllIPs)", async () => {
  const publicTv = device({ id: "pub", host: "8.8.8.8", addresses: ["8.8.8.8"] });
  const loop = device({ id: "loop", host: "127.0.0.1", addresses: ["127.0.0.1"] });
  const warn = console.warn;
  const warnings: string[] = [];
  console.warn = (m: string) => void warnings.push(m);
  try {
    const strict = setup();
    const skipped: string[] = [];
    strict.service.on("skipped", (d, reason) => skipped.push(`${d.id}: ${reason}`));
    strict.source.list = [publicTv, loop, GROUP];
    strict.source.emit("deviceUp", publicTv);
    await strict.service.settled();
    assert.deepEqual(strict.service.sinks().map((d) => d.id), ["dev-group"]);
    assert.deepEqual(skipped, ["pub: 8.8.8.8 is a publicly routable address (allowAllIps is off)", "loop: 127.0.0.1 is a loopback address (allowAllIps is off)"]);
    assert.equal(warnings.length, 2, "each is logged once");
    strict.source.emit("deviceChanged", publicTv);
    await strict.service.settled();
    assert.equal(warnings.length, 2, "and not again");
    strict.service.dispose();

    const lax = setup({ allowAllIps: true });
    lax.source.list = [publicTv, loop];
    lax.source.emit("deviceUp", publicTv);
    await lax.service.settled();
    assert.deepEqual(lax.service.sinks().map((d) => d.id).sort(), ["loop", "pub"]);
    lax.service.dispose();
  } finally {
    console.warn = warn;
  }
});

test("a device found by host name is skipped with a reason, as a channel is opened to IP addresses only", async () => {
  const named = device({ id: "named", host: "tv.local", addresses: [] });
  const warn = console.warn;
  const warnings: string[] = [];
  console.warn = (m: string) => void warnings.push(m);
  try {
    const { source, service, clients } = setup();
    const skipped: string[] = [];
    service.on("skipped", (_d, reason) => skipped.push(reason));
    source.list = [named, GROUP];
    source.emit("deviceUp", named);
    await service.settled();
    assert.deepEqual(service.sinks().map((d) => d.id), ["dev-group"]);
    assert.equal(clients.length, 1, "no client was made for the name");
    assert.match(skipped[0] ?? "", /"tv\.local" is a host name, not an IP address/);
    assert.match(warnings[0] ?? "", /named/);
    service.dispose();
  } finally {
    console.warn = warn;
  }
});

test("isPubliclyRoutable and isLoopback follow net/base/ip_address.cc", () => {
  for (const h of ["10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.1.1", "100.64.0.1", "127.0.0.1", "fe80::1", "fd00::1", "::1"]) {
    assert.equal(isPubliclyRoutable(h), false, h);
  }
  for (const h of ["8.8.8.8", "172.32.0.1", "1.1.1.1", "2001:4860:4860::8888", "::ffff:8.8.8.8"]) {
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
  await service.settled();
  assert.equal(clients.length, 1);
  assert.deepEqual(service.sinks(), []);
  fail = false;
  service.discoverSinksNow();
  await service.settled();
  assert.deepEqual(service.sinks().map((d) => d.id), ["dev-tv"]);
  service.dispose();
});

test("dispose closes every channel, stops pending work and silences events", async () => {
  const { source, service, clients } = setup();
  source.up(TV);
  source.up(SPEAKER);
  await service.settled();
  let events = 0;
  service.on("deviceUp", () => events++);
  service.on("deviceDown", () => events++);
  source.up(GROUP);
  service.dispose();
  await new Promise((r) => setTimeout(r, 5));
  assert.ok(clients.every((c) => c.closed));
  assert.equal(events, 0);
  assert.deepEqual(service.sinks(), []);
  assert.equal(source.listenerCount("deviceUp"), 0);
  service.dispose();
});
