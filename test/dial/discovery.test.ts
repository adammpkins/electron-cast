// SSDP discovery over real UDP on localhost, and the sink service on top of the registry (dial_service_impl.cc,
// dial_registry.cc, dial_media_sink_service_impl.cc).
import { test } from "node:test";
import assert from "node:assert/strict";
import dgram from "node:dgram";
import { EventEmitter } from "node:events";
import type { AddressInfo } from "node:net";
import { DialRegistry } from "../../src/dial/dial-registry.ts";
import { DialSinkService } from "../../src/dial/dial-sink-service.ts";
import { openUdpSsdpSocket } from "../../src/dial/ssdp-socket.ts";
import type { DialDeviceData } from "../../src/dial/parse.ts";
import {
  APP_URL, DESCRIPTION_URL, DEVICE_IP, SINK_ID, UDN, FakeHttp, appInfoXml, descriptionXml, healthyDevice, httpError, ok, sleep, ssdpAnswer,
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
  await sleep(300);
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
    const registry = new DialRegistry({
      interfaces: () => LOOPBACK,
      openSocket: (iface, handlers) => openUdpSsdpSocket(iface, handlers, { target: { address: "127.0.0.1", port: fake.port } }),
      requestIntervalMs: 10, responseTimeoutMs: 40, maxRequests: 2,
    });
    registry.start();
    await sleep(150);
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
  await sleep(60);
  assert.equal(registry.devices().length, 1);
  answering = false;
  clock += 241_000;
  assert.ok(registry.discoverNow());
  await sleep(60);
  assert.equal(registry.devices().length, 0, "not heard from for longer than 240 s");
  assert.equal(lists.at(-1), 0, "the changed list is published");
  assert.equal(sent.length, 2);
  registry.stop();
});

test("the registry reports no interfaces and keeps going", async () => {
  const codes: string[] = [];
  const registry = new DialRegistry({ interfaces: () => [], refreshMs: 60_000 });
  registry.on("error", (code) => codes.push(code));
  registry.start();
  await sleep(20);
  assert.deepEqual(codes, ["no_interfaces"]);
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

function sinkService(http: FakeHttp, over: { isCastSink?: (uuid: string) => boolean } = {}) {
  const registry = new FakeRegistry();
  const sinks = new DialSinkService({ source: registry, http, settleMs: 10, ...over });
  return { registry, sinks };
}

test("a device becomes a sink named from its description after the settle delay", async () => {
  const { registry, sinks } = sinkService(healthyDevice());
  const changes: number[] = [];
  sinks.on("change", () => changes.push(sinks.sinks().length));
  registry.emit("deviceList", [DEVICE]);
  assert.equal(sinks.sinks().length, 0, "published only after the timer");
  await sleep(60);
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
    await sleep(40);
    assert.deepEqual(sinks.sinks(), []);
    sinks.stop();
  }
});

test("a sink loses its place when the next device list leaves it out", async () => {
  const { registry, sinks } = sinkService(healthyDevice());
  registry.emit("deviceList", [DEVICE]);
  await sleep(40);
  assert.equal(sinks.sinks().length, 1);
  registry.emit("deviceList", []);
  await sleep(40);
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
  await sleep(60);
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
  await sleep(60);
  assert.deepEqual(sinks.availableSinks("YouTube"), []);
  const asked = http.calls.filter((c) => c.url === `${APP_URL}/YouTube`).length;
  assert.equal(asked, 1);
  http.reply("GET", `${APP_URL}/YouTube`, ok(appInfoXml("running")));
  sinks.discoverNow();
  await sleep(40);
  assert.equal(registry.discovered, 1);
  assert.deepEqual(sinks.availableSinks("YouTube").map((s) => s.id), [SINK_ID]);
  sinks.stop();
});

test("apps are not queried on a discovery-only model", async () => {
  const http = new FakeHttp().reply("GET", DESCRIPTION_URL, ok(descriptionXml({ modelName: "Chromecast Ultra" }), { "application-url": `${APP_URL}/` }));
  const { registry, sinks } = sinkService(http);
  sinks.monitorApp("YouTube");
  registry.emit("deviceList", [DEVICE]);
  await sleep(60);
  assert.equal(sinks.sinks().length, 1, "it is still a sink");
  assert.equal(http.calls.some((c) => c.url.endsWith("/YouTube")), false);
  sinks.stop();
});

test("a DIAL sink that is also a Cast device is hidden, the way Chrome leaves it a Cast sink", async () => {
  let cast = true;
  const { registry, sinks } = sinkService(healthyDevice(), { isCastSink: (uuid) => cast && uuid === "aaaa1111222233334444555566667777" });
  sinks.monitorApp("YouTube");
  registry.emit("deviceList", [DEVICE]);
  await sleep(60);
  assert.deepEqual(sinks.sinks(), []);
  assert.deepEqual(sinks.availableSinks("YouTube"), []);
  cast = false;
  sinks.refilter();
  await sleep(30);
  assert.equal(sinks.sinks().length, 1);
  sinks.stop();
});
