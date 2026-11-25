// SSDP discovery over real UDP on localhost, and the sink service on top of the registry (dial_service_impl.cc,
// dial_registry.cc, dial_media_sink_service_impl.cc).
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import dgram from "node:dgram";
import { EventEmitter } from "node:events";
import type { AddressInfo } from "node:net";
import { DialRegistry } from "../../src/dial/dial-registry.ts";
import { DialSinkService } from "../../src/dial/dial-sink-service.ts";
import { openUdpSsdpSocket, type SsdpSocketHandlers } from "../../src/dial/ssdp-socket.ts";
import type { DialDeviceData } from "../../src/dial/parse.ts";
import {
  APP_URL, DESCRIPTION_URL, DEVICE_IP, SINK_ID, UDN, FakeHttp, appInfoXml, descriptionXml, healthyDevice, httpError, ok, flush, ssdpAnswer, until,
} from "./fixtures.ts";

/** A UDP responder standing in for the SSDP group: it answers every M-SEARCH it hears. */
async function responder(answer: string | null): Promise<{ port: number; requests: string[]; close(): void }> {
  const requests: string[] = [];
  const socket = dgram.createSocket("udp4");
  socket.on("message", (msg, rinfo) => {
    requests.push(msg.toString("latin1"));
    if (answer !== null) socket.send(answer, rinfo.port, rinfo.address);
  });
  await new Promise<void>((r) => socket.bind(0, "127.0.0.1", r));
  return { port: (socket.address() as AddressInfo).port, requests, close: () => socket.close() };
}

const LOOPBACK = [{ name: "lo", address: "127.0.0.1" }];

test("a search goes out four times per cycle and a device that answers is registered once", async () => {
  const fake = await responder(ssdpAnswer({ location: "http://127.0.0.1:8008/desc.xml" }));
  const registry = new DialRegistry({
    interfaces: () => LOOPBACK,
    openSocket: (iface, handlers) => openUdpSsdpSocket(iface, handlers, { target: { address: "127.0.0.1", port: fake.port } }),
    userAgent: "Test/1 Windows",
    requestIntervalMs: 20,
    responseTimeoutMs: 80,
    refreshMs: 10_000,
  });
  const lists: DialDeviceData[][] = [];
  registry.on("deviceList", (l) => lists.push(l));
  registry.start();
  await until(() => fake.requests.length === 4 && (lists.at(-1)?.length ?? 0) === 1);
  registry.stop();
  fake.close();

  assert.equal(fake.requests.length, 4, "kDialMaxRequests searches in a cycle");
  assert.equal(fake.requests[0], "M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: \"ssdp:discover\"\r\nMX: 1\r\n"
    + "ST: urn:dial-multiscreen-org:service:dial:1\r\nUSER-AGENT: Test/1 Windows\r\n\r\n");
  const last = lists.at(-1) ?? [];
  assert.equal(last.length, 1);
  assert.equal(last[0]?.label, "1");
  assert.equal(last[0]?.ipAddress, "127.0.0.1");
  assert.equal(last[0]?.descriptionUrl, "http://127.0.0.1:8008/desc.xml");
});

test("an answer whose LOCATION does not name the sender is ignored, and so is one that is not a full header block", async () => {
  const wrongHost = await responder(ssdpAnswer({ location: "http://192.168.9.9/desc.xml" }));
  const truncated = await responder("HTTP/1.1 200 OK\r\nUSN: x\r\n");
  for (const fake of [wrongHost, truncated]) {
    let heard = 0;
    const registry = new DialRegistry({
      interfaces: () => LOOPBACK,
      openSocket: (iface, handlers) => openUdpSsdpSocket(
        iface,
        { ...handlers, message: (packet, from) => { heard++; handlers.message(packet, from); } },
        { target: { address: "127.0.0.1", port: fake.port } },
      ),
      requestIntervalMs: 10, responseTimeoutMs: 40, maxRequests: 2,
    });
    registry.start();
    // Both answers have reached the registry (and been dropped) when the count says so.
    await until(() => heard === 2);
    assert.deepEqual(registry.devices(), []);
    registry.stop();
    fake.close();
  }
});

test("a device that stops answering is dropped after its lifetime, and a new cycle asks again", async () => {
  let clock = 1_000_000;
  const sent: string[] = [];
  let answering = true;
  const handlersSeen: Array<(packet: Buffer, from: { address: string; port: number }) => void> = [];
  const registry = new DialRegistry({
    interfaces: () => LOOPBACK,
    openSocket: async (_iface, handlers) => {
      handlersSeen.push(handlers.message);
      return {
        send(packet) {
          sent.push(packet.toString("latin1"));
          if (answering) queueMicrotask(() => handlers.message(Buffer.from(ssdpAnswer({ location: "http://127.0.0.1:8008/d.xml" }), "latin1"), { address: "127.0.0.1", port: 1900 }));
        },
        close() {},
      };
    },
    now: () => clock,
    requestIntervalMs: 5, responseTimeoutMs: 10, maxRequests: 1, refreshMs: 60_000, expirationMs: 240_000,
  });
  const lists: number[] = [];
  registry.on("deviceList", (l) => lists.push(l.length));
  registry.start();
  await until(() => registry.devices().length === 1);
  answering = false;
  // discoverNow refuses while the first cycle runs, so this also waits for that cycle to end.
  await until(() => registry.discoverNow());
  clock += 241_000;
  await until(() => lists.at(-1) === 0);
  assert.equal(registry.devices().length, 0, "not heard from for longer than 240 s");
  assert.equal(lists.at(-1), 0, "the changed list is published");
  assert.equal(sent.length, 2);
  registry.stop();
});

test("with no interfaces the registry starts without throwing, publishes the empty list and searches again at each refresh", () => {
  // DialServiceImpl::DiscoverOnAddresses finishes at once for an empty address list, and reports no error.
  mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  try {
    let looked = 0;
    const lists: number[] = [];
    const registry = new DialRegistry({ interfaces: () => { looked++; return []; }, refreshMs: 60_000 });
    registry.on("deviceList", (l) => lists.push(l.length));
    assert.doesNotThrow(() => registry.start(), "no \"error\" listener is needed");
    assert.equal(looked, 1);
    assert.deepEqual(lists, [0]);
    mock.timers.tick(60_000);
    assert.equal(looked, 2, "the refresh timer is installed");
    registry.stop();
  } finally {
    mock.timers.reset();
  }
});

test("a socket that fails is closed and reported, and the registry never throws for it", async () => {
  // DialSocket::CheckResult closes the socket and DialServiceImpl::NotifyOnError reports socket_error while another
  // socket is open and no_interfaces when none is.
  const handlers = new Map<string, SsdpSocketHandlers>();
  const closed: string[] = [];
  const registry = new DialRegistry({
    interfaces: () => [{ name: "a", address: "10.0.0.1" }, { name: "b", address: "10.0.0.2" }, { name: "c", address: "10.0.0.3" }],
    openSocket: async (iface, h) => {
      if (iface.address === "10.0.0.3") throw new Error("EADDRNOTAVAIL");
      handlers.set(iface.address, h);
      return { send() {}, close() { closed.push(iface.address); } };
    },
    refreshMs: 60_000,
  });
  // No listener yet: a failure must not throw out of the socket callback.
  registry.start();
  await until(() => handlers.size === 2);
  await flush();
  assert.doesNotThrow(() => handlers.get("10.0.0.1")?.error(new Error("socket a failed")));
  const seen: Array<[string, string | undefined]> = [];
  registry.on("error", (code, detail) => seen.push([code, detail?.message]));
  handlers.get("10.0.0.2")?.error(new Error("socket b failed"));
  assert.deepEqual(seen, [["no_interfaces", "socket b failed"]]);
  assert.deepEqual(closed.sort(), ["10.0.0.1", "10.0.0.2"]);
  registry.stop();
});

test("a socket that cannot be bound is reported as a socket error while another is open", async () => {
  const seen: string[] = [];
  const registry = new DialRegistry({
    interfaces: () => [{ name: "a", address: "10.0.0.1" }, { name: "b", address: "10.0.0.2" }],
    openSocket: async (iface) => {
      if (iface.address === "10.0.0.2") {
        // b fails after a is open, as the sockets are bound one after another.
        await flush();
        throw new Error("EADDRNOTAVAIL");
      }
      return { send() {}, close() {} };
    },
    refreshMs: 60_000,
  });
  registry.on("error", (code) => seen.push(code));
  registry.start();
  await until(() => seen.length === 1);
  assert.deepEqual(seen, ["socket_error"]);
  registry.stop();
});

/** A registry stand-in for the sink service tests: the test publishes device lists by hand. */
class FakeRegistry extends EventEmitter<{ deviceList: [DialDeviceData[]] }> {
  discovered = 0;
  discoverNow(): boolean {
    this.discovered++;
    return true;
  }
}

const DEVICE: DialDeviceData = {
  deviceId: `${UDN}::urn:dial-multiscreen-org:service:dial:1`, label: "1", ipAddress: DEVICE_IP,
  descriptionUrl: DESCRIPTION_URL, responseTime: 0, maxAge: null, configId: null,
};

/**
 * The settle timer is mocked: `settle()` lets the fake HTTP answers through, fires the timer, and lets the app-info
 * answers that follow through. Tests call `mock.timers.reset()` in a finally.
 */
function sinkService(http: FakeHttp, over: { isCastSink?: (uuid: string) => boolean } = {}) {
  mock.timers.reset();
  mock.timers.enable({ apis: ["setTimeout"] });
  const registry = new FakeRegistry();
  const sinks = new DialSinkService({ source: registry, http, settleMs: 10, ...over });
  return { registry, sinks };
}

async function settle(): Promise<void> {
  await flush();
  mock.timers.tick(10);
  await flush();
}

test.afterEach(() => mock.timers.reset());

test("a device becomes a sink named from its description after the settle delay", async () => {
  const { registry, sinks } = sinkService(healthyDevice());
  const changes: number[] = [];
  sinks.on("change", () => changes.push(sinks.sinks().length));
  registry.emit("deviceList", [DEVICE]);
  assert.equal(sinks.sinks().length, 0, "published only after the timer");
  await settle();
  assert.deepEqual(sinks.sinks(), [{ id: SINK_ID, name: "Living Room TV", modelName: "Smart TV", ipAddress: DEVICE_IP, appUrl: APP_URL }]);
  assert.deepEqual(changes, [1]);
  const [description] = sinks["http"] instanceof FakeHttp ? (sinks["http"] as FakeHttp).calls : [];
  assert.equal(description?.setOrigin, false, "the description is fetched without an Origin header");
  sinks.stop();
});

test("a device whose description fails validation is not a sink", async () => {
  const wrongAppUrl = new FakeHttp().reply("GET", DESCRIPTION_URL, ok(descriptionXml(), { "application-url": "http://10.9.9.9/apps" }));
  const noHeader = new FakeHttp().reply("GET", DESCRIPTION_URL, ok(descriptionXml()));
  const garbage = new FakeHttp().reply("GET", DESCRIPTION_URL, ok("<html/>", { "application-url": `${APP_URL}/` }));
  const unreachable = new FakeHttp();
  for (const http of [wrongAppUrl, noHeader, garbage, unreachable]) {
    const { registry, sinks } = sinkService(http);
    registry.emit("deviceList", [DEVICE]);
    await settle();
    assert.deepEqual(sinks.sinks(), []);
    sinks.stop();
  }
});

test("a sink loses its place when the next device list leaves it out", async () => {
  const { registry, sinks } = sinkService(healthyDevice());
  registry.emit("deviceList", [DEVICE]);
  await settle();
  assert.equal(sinks.sinks().length, 1);
  registry.emit("deviceList", []);
  await settle();
  assert.equal(sinks.sinks().length, 0);
  sinks.stop();
});

test("a monitored app is available when app info says running or stopped, and not when the device says 404", async () => {
  const http = healthyDevice("stopped").reply("GET", `${APP_URL}/Missing`, httpError(404)).reply("GET", `${APP_URL}/Broken`, ok("<nope/>"));
  const { registry, sinks } = sinkService(http);
  const changes: number[] = [];
  sinks.on("change", () => changes.push(1));
  const release = sinks.monitorApp("YouTube");
  sinks.monitorApp("Missing");
  sinks.monitorApp("Broken");
  registry.emit("deviceList", [DEVICE]);
  await settle();
  assert.deepEqual(sinks.availableSinks("YouTube").map((s) => s.id), [SINK_ID]);
  assert.deepEqual(sinks.availableSinks("Missing"), []);
  assert.deepEqual(sinks.availableSinks("Broken"), []);
  assert.ok(changes.length >= 1, "the sink service reports the new sink");
  release();
  sinks.stop();
});

test("a network error leaves the app status unknown and discoverNow asks again", async () => {
  const http = new FakeHttp().reply("GET", DESCRIPTION_URL, ok(descriptionXml(), { "application-url": `${APP_URL}/` }));
  const { registry, sinks } = sinkService(http);
  sinks.monitorApp("YouTube");
  registry.emit("deviceList", [DEVICE]);
  await settle();
  assert.deepEqual(sinks.availableSinks("YouTube"), []);
  const asked = http.calls.filter((c) => c.url === `${APP_URL}/YouTube`).length;
  assert.equal(asked, 1);
  http.reply("GET", `${APP_URL}/YouTube`, ok(appInfoXml("running")));
  sinks.discoverNow();
  await flush();
  assert.equal(registry.discovered, 1);
  assert.deepEqual(sinks.availableSinks("YouTube").map((s) => s.id), [SINK_ID]);
  sinks.stop();
});

test("apps are not queried on a discovery-only model", async () => {
  const http = new FakeHttp().reply("GET", DESCRIPTION_URL, ok(descriptionXml({ modelName: "Chromecast Ultra" }), { "application-url": `${APP_URL}/` }));
  const { registry, sinks } = sinkService(http);
  sinks.monitorApp("YouTube");
  registry.emit("deviceList", [DEVICE]);
  await settle();
  assert.equal(sinks.sinks().length, 1, "it is still a sink");
  assert.equal(http.calls.some((c) => c.url.endsWith("/YouTube")), false);
  sinks.stop();
});

test("a DIAL sink that is also a Cast device is hidden, the way Chrome leaves it a Cast sink", async () => {
  let cast = true;
  const { registry, sinks } = sinkService(healthyDevice(), { isCastSink: (uuid) => cast && uuid === "aaaa1111222233334444555566667777" });
  sinks.monitorApp("YouTube");
  registry.emit("deviceList", [DEVICE]);
  await settle();
  assert.deepEqual(sinks.sinks(), []);
  assert.deepEqual(sinks.availableSinks("YouTube"), []);
  cast = false;
  sinks.refilter();
  await settle();
  assert.equal(sinks.sinks().length, 1);
  sinks.stop();
});

test("the monitored apps and the remembered statuses are bounded, and stop forgets them", async () => {
  const http = healthyDevice("stopped");
  for (let i = 0; i < 40; i++) http.reply("GET", `${APP_URL}/App${i}`, httpError(404));
  const { registry, sinks } = sinkService(http);
  registry.emit("deviceList", [DEVICE]);
  await settle();
  // 32 apps are monitored at once; the next one is ignored, and releasing it changes nothing.
  const releases = Array.from({ length: 40 }, (_, i) => sinks.monitorApp(`App${i}`));
  await flush();
  const asked = new Set(http.calls.filter((c) => c.url.startsWith(`${APP_URL}/App`)).map((c) => c.url));
  assert.equal(asked.size, 32);
  assert.equal((sinks as unknown as { statuses: Map<string, string> }).statuses.size, 32);
  releases.forEach((release) => release());
  sinks.stop();
  assert.equal((sinks as unknown as { statuses: Map<string, string> }).statuses.size, 0);
  assert.equal((sinks as unknown as { cache: Map<string, unknown> }).cache.size, 0);
});
