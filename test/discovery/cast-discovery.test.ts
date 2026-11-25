import { test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import type { NetworkInterfaceInfo as OsInterface } from "node:os";
import {
  CastDiscovery,
  listIPv4Interfaces,
  listMdnsInterfaces,
  type CastDiscoveryOptions,
  type MdnsSocket,
  type MdnsSocketHandlers,
  type NetworkInterfaceInfo,
} from "../../src/discovery/cast-discovery.ts";
import type { CastDevice } from "../../src/discovery/device-cache.ts";
import { encodeMdnsQuery, RecordType } from "../../src/discovery/dns-packet.ts";
import { dnsName, fixture, header, rr, txt } from "./helpers.ts";

const SERVICE = "_googlecast._tcp.local";
const QUERY = encodeMdnsQuery(SERVICE, RecordType.PTR);

// ---------------------------------------------------------------------------------------------------------------
// Wire-format builders

interface Announce {
  id: string;
  fn: string;
  addr?: string;
  aaaa?: string[];
  port?: number;
  ca?: number;
  ttl?: number;
  flags?: number;
}

const instanceOf = (id: string) => `Chromecast-${id}.${SERVICE}`;

function ipv6Bytes(address: string): Buffer {
  const [head = "", tail] = address.split("::");
  const words = (part: string) => (part === "" ? [] : part.split(":").map((w) => parseInt(w, 16)));
  const h = words(head);
  const t = tail === undefined ? [] : words(tail);
  const all = [...h, ...Array<number>(tail === undefined ? 0 : 8 - h.length - t.length).fill(0), ...t];
  const b = Buffer.alloc(16);
  all.forEach((w, i) => b.writeUInt16BE(w, i * 2));
  return b;
}

function announce(o: Announce, opts: { cacheFlush?: boolean } = {}): Buffer {
  const flush = opts.cacheFlush === false ? 0x0001 : 0x8001;
  const instance = instanceOf(o.id);
  const host = `${o.id}.local`;
  const ttl = o.ttl ?? 120;
  const srv = Buffer.concat([Buffer.from([0, 0, 0, 0, (o.port ?? 8009) >> 8, (o.port ?? 8009) & 0xff]), dnsName(host)]);
  return Buffer.concat([
    header({ an: 1, ar: 2 + (o.addr ? 1 : 0) + (o.aaaa?.length ?? 0), flags: o.flags ?? 0x8400 }),
    rr(SERVICE, RecordType.PTR, 1, ttl, dnsName(instance)),
    rr(instance, RecordType.SRV, 0x8001, ttl, srv),
    rr(instance, RecordType.TXT, 0x8001, 4500, txt([`id=${o.id}`, `fn=${o.fn}`, "md=Chromecast", `ca=${o.ca ?? 5}`, "rs="])),
    ...(o.addr ? [rr(host, RecordType.A, flush, ttl, Buffer.from(o.addr.split(".").map(Number)))] : []),
    ...(o.aaaa ?? []).map((a) => rr(host, RecordType.AAAA, flush, ttl, ipv6Bytes(a))),
  ]);
}

function goodbye(id: string): Buffer {
  return Buffer.concat([header({ an: 1 }), rr(SERVICE, RecordType.PTR, 1, 0, dnsName(instanceOf(id)))]);
}

/** Several records in one response: a goodbye for `byeId`, a TXT rename for `renameId`, a new device. */
function mixed(byeId: string, renameId: string, rename: string, add: Announce): Buffer {
  const instance = instanceOf(renameId);
  const addBody = announce(add).subarray(12);
  return Buffer.concat([
    header({ an: 3, ar: 3 }),
    rr(SERVICE, RecordType.PTR, 1, 0, dnsName(instanceOf(byeId))),
    rr(instance, RecordType.TXT, 0x8001, 4500, txt([`id=${renameId}`, `fn=${rename}`, "md=Chromecast", "ca=5", "rs="])),
    addBody,
  ]);
}

const TV: Announce = { id: "aaaa0000000000000000000000000001", fn: "Lounge TV", addr: "10.0.0.10" };
const SPEAKER: Announce = { id: "bbbb0000000000000000000000000002", fn: "Study speaker", addr: "10.0.0.20" };
const HUB: Announce = { id: "cccc0000000000000000000000000003", fn: "Kitchen display", addr: "10.0.0.30" };

// ---------------------------------------------------------------------------------------------------------------
// Fakes

class FakeSocket implements MdnsSocket {
  readonly iface: NetworkInterfaceInfo;
  readonly handlers: MdnsSocketHandlers;
  sent: Buffer[] = [];
  closed = false;
  constructor(iface: NetworkInterfaceInfo, handlers: MdnsSocketHandlers) {
    this.iface = iface;
    this.handlers = handlers;
  }
  send(packet: Buffer): void {
    if (this.closed) throw new Error(`send on closed socket ${this.iface.address}`);
    this.sent.push(Buffer.from(packet));
  }
  close(): void {
    this.closed = true;
  }
  receive(packet: Buffer, from = "10.0.0.10"): void {
    this.handlers.message(packet, { address: from, port: 5353 });
  }
}

class FakeNet {
  ifaces: NetworkInterfaceInfo[];
  /** Every socket ever opened, in order. */
  sockets: FakeSocket[] = [];
  /** Addresses passed to openSocket, in order, including failed attempts. */
  attempts: string[] = [];
  failOpen = new Map<string, Error>();

  constructor(ifaces: NetworkInterfaceInfo[]) {
    this.ifaces = ifaces;
  }

  readonly interfaces = () => this.ifaces.map((i) => ({ ...i }));

  readonly openSocket = async (iface: NetworkInterfaceInfo, handlers: MdnsSocketHandlers): Promise<MdnsSocket> => {
    this.attempts.push(iface.address);
    await Promise.resolve();
    const err = this.failOpen.get(iface.address);
    if (err) throw err;
    const s = new FakeSocket(iface, handlers);
    this.sockets.push(s);
    return s;
  };

  /** The open (not closed) socket for an address. */
  on(address: string): FakeSocket {
    const s = this.sockets.find((x) => x.iface.address === address && !x.closed);
    assert.ok(s, `no open socket for ${address}`);
    return s;
  }

  queriesOn(address: string): number {
    return this.sockets.filter((s) => s.iface.address === address).reduce((n, s) => n + s.sent.length, 0);
  }
}

const ETH: NetworkInterfaceInfo = { name: "Ethernet", address: "10.0.0.5", scopeId: 12 };
const ETH6: NetworkInterfaceInfo = { name: "Ethernet", address: "fe80::5", family: "IPv6", scopeId: 12 };
const WIFI6: NetworkInterfaceInfo = { name: "Wi-Fi", address: "fe80::5", family: "IPv6", scopeId: 7 };
const WIFI: NetworkInterfaceInfo = { name: "Wi-Fi", address: "192.168.1.5" };
const WSL: NetworkInterfaceInfo = { name: "vEthernet (WSL)", address: "172.20.0.1" };

interface Logged {
  type: "deviceUp" | "deviceDown" | "deviceChanged";
  id: string;
  name: string;
}

function setup(ifaces: NetworkInterfaceInfo[] = [ETH, WIFI], extra: CastDiscoveryOptions = {}) {
  const net = new FakeNet(ifaces);
  const discovery = new CastDiscovery({ interfaces: net.interfaces, openSocket: net.openSocket, ...extra });
  const events: Logged[] = [];
  const errors: { address: string; message: string }[] = [];
  for (const type of ["deviceUp", "deviceDown", "deviceChanged"] as const) {
    discovery.on(type, (d: CastDevice) => events.push({ type, id: d.id, name: d.name }));
  }
  discovery.on("socketError", (iface, error) => errors.push({ address: iface.address, message: error.message }));
  return { net, discovery, events, errors };
}

/** Lets promise chains started by a timer (socket opens) finish. setImmediate is not mocked. */
const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

async function advance(ms: number): Promise<void> {
  mock.timers.tick(ms);
  await flush();
}

beforeEach(() => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 0 });
});

afterEach(() => {
  mock.timers.reset();
});

// ---------------------------------------------------------------------------------------------------------------
// listIPv4Interfaces

test("listIPv4Interfaces keeps external IPv4 addresses, in order, once each", () => {
  const nets = {
    Ethernet: [
      { address: "fe80::1", family: "IPv6", internal: false },
      { address: "10.0.0.5", family: "IPv4", internal: false },
    ],
    "Loopback Pseudo-Interface 1": [{ address: "127.0.0.1", family: "IPv4", internal: true }],
    "Wi-Fi": [{ address: "169.254.3.4", family: "IPv4", internal: false }],
    "vEthernet (WSL)": [{ address: "172.20.0.1", family: "IPv4", internal: false }],
    "Old Node": [{ address: "192.168.1.5", family: 4, internal: false }],
    Duplicate: [{ address: "10.0.0.5", family: "IPv4", internal: false }],
  } as unknown as NodeJS.Dict<OsInterface[]>;
  assert.deepEqual(listIPv4Interfaces(nets), [
    { name: "Ethernet", address: "10.0.0.5" },
    { name: "vEthernet (WSL)", address: "172.20.0.1" },
    { name: "Old Node", address: "192.168.1.5" },
  ]);
});

test("listMdnsInterfaces adds one link-local IPv6 interface per adapter, with its scope", () => {
  const nets = {
    Ethernet: [
      { address: "fe80::5", family: "IPv6", internal: false, scopeid: 12 },
      { address: "2001:db8::5", family: "IPv6", internal: false, scopeid: 0 },
      { address: "fe80::6", family: "IPv6", internal: false, scopeid: 12 },
      { address: "10.0.0.5", family: "IPv4", internal: false },
    ],
    "Wi-Fi": [{ address: "fe80::5", family: "IPv6", internal: false, scopeid: 7 }],
    "No scope": [{ address: "fe80::9", family: "IPv6", internal: false, scopeid: 0 }],
    Loopback: [{ address: "::1", family: "IPv6", internal: true, scopeid: 0 }],
  } as unknown as NodeJS.Dict<OsInterface[]>;
  assert.deepEqual(listMdnsInterfaces(nets), [
    { name: "Ethernet", address: "10.0.0.5", scopeId: 12 },
    { name: "Ethernet", address: "fe80::5", family: "IPv6", scopeId: 12 },
    { name: "Wi-Fi", address: "fe80::5", family: "IPv6", scopeId: 7 },
  ]);
  assert.deepEqual(listIPv4Interfaces(nets), [{ name: "Ethernet", address: "10.0.0.5" }]);
});

test("listIPv4Interfaces reads the machine's interfaces by default", () => {
  const list = listIPv4Interfaces();
  assert.ok(Array.isArray(list));
  assert.ok(list.every((i) => typeof i.name === "string" && /^\d+\.\d+\.\d+\.\d+$/.test(i.address)));
  assert.ok(!list.some((i) => i.address.startsWith("127.")));
});

// ---------------------------------------------------------------------------------------------------------------
// Sockets and queries

test("start opens one socket per interface and sends a PTR query on each before resolving", async () => {
  const { net, discovery } = setup([ETH, WIFI, WSL]);
  await discovery.start();
  assert.deepEqual(net.attempts, [ETH.address, WIFI.address, WSL.address]);
  for (const s of net.sockets) assert.deepEqual(s.sent, [QUERY]);
  assert.deepEqual(discovery.interfaces(), [ETH, WIFI, WSL]);
});

test("start called twice opens each socket once", async () => {
  const { net, discovery } = setup();
  await Promise.all([discovery.start(), discovery.start()]);
  await discovery.start();
  assert.deepEqual(net.attempts, [ETH.address, WIFI.address]);
});

test("queries again 1 s and 3 s after start, then every 60 s", async () => {
  // This test jumps the mocked clock by a minute at a time, which is not a sleep.
  const { net, discovery } = setup([ETH], { resumeGapMs: Infinity });
  await discovery.start();
  const at = async (to: number, expected: number) => {
    await advance(to - Date.now());
    assert.equal(net.queriesOn(ETH.address), expected, `queries sent by t=${to}`);
  };
  await at(999, 1);
  await at(1000, 2);
  await at(2999, 2);
  await at(3000, 3);
  await at(62_999, 3);
  await at(63_000, 4);
  await at(123_000, 5);
  assert.ok(net.on(ETH.address).sent.every((p) => p.equals(QUERY)));
});

test("query timings can be configured", async () => {
  const { net, discovery } = setup([ETH], { followUpQueriesMs: [500], refreshMs: 10_000 });
  await discovery.start();
  await advance(500);
  assert.equal(net.queriesOn(ETH.address), 2);
  await advance(10_000);
  assert.equal(net.queriesOn(ETH.address), 3);
});

test("query() sends one more query on every open socket now", async () => {
  const { net, discovery } = setup();
  await discovery.start();
  discovery.query();
  assert.equal(net.queriesOn(ETH.address), 2);
  assert.equal(net.queriesOn(WIFI.address), 2);
});

test("a custom service name is queried and watched", async () => {
  const name = "_test-cast._tcp.local";
  const { net, discovery } = setup([ETH], { serviceName: name });
  await discovery.start();
  assert.deepEqual(net.on(ETH.address).sent, [encodeMdnsQuery(name, RecordType.PTR)]);
});

// ---------------------------------------------------------------------------------------------------------------
// Devices

test("a response on any interface brings devices up", async () => {
  const { net, discovery, events } = setup();
  await discovery.start();
  net.on(WIFI.address).receive(announce(TV));
  assert.deepEqual(events, [{ type: "deviceUp", id: TV.id, name: "Lounge TV" }]);
  const [d] = discovery.devices();
  assert.equal(d?.host, "10.0.0.10");
  assert.equal(d?.port, 8009);
  assert.equal(discovery.devices().length, 1);
});

test("one packet can bring several devices up (Fuchsia hub and its groups)", async () => {
  const { net, discovery, events } = setup();
  await discovery.start();
  net.on(ETH.address).receive(fixture("fuchsia-hub-max-groups"));
  assert.equal(events.length, 3);
  assert.ok(events.every((e) => e.type === "deviceUp"));
  assert.equal(discovery.devices().length, 3);
});

test("the same answer heard on two interfaces is one device", async () => {
  const { net, discovery, events } = setup();
  await discovery.start();
  net.on(ETH.address).receive(announce(TV));
  net.on(WIFI.address).receive(announce(TV));
  assert.equal(events.length, 1);
  assert.equal(discovery.devices().length, 1);
});

test("a device that only has AAAA records is found; global IPv6 is preferred to link-local", async () => {
  const { net, discovery, events } = setup([ETH, ETH6]);
  await discovery.start();
  const v6only: Announce = { id: "dddd0000000000000000000000000004", fn: "v6 only", aaaa: ["fe80::abcd", "2001:db8::10"] };
  net.on("fe80::5").receive(announce(v6only));
  assert.deepEqual(events, [{ type: "deviceUp", id: v6only.id, name: "v6 only" }]);
  const [d] = discovery.devices();
  assert.equal(d?.host, "2001:db8::10");
  assert.deepEqual(d?.addresses, ["2001:db8::10", "fe80::abcd%12"]);
});

test("a link-local-only device gets the scope of the interface that heard it, so it can be connected to", async () => {
  const { net, discovery } = setup([ETH, WIFI6, ETH6]);
  await discovery.start();
  net.on("fe80::5").receive(announce({ id: "dddd0000000000000000000000000004", fn: "ll", aaaa: ["fe80::abcd"] }));
  assert.equal(discovery.devices()[0]?.host, "fe80::abcd%7", "the first socket with that address is WIFI6's");
  const other = setup([ETH, ETH6]);
  await other.discovery.start();
  other.net.on("10.0.0.5").receive(announce({ id: "dddd0000000000000000000000000004", fn: "ll", aaaa: ["fe80::abcd"] }));
  assert.equal(other.discovery.devices()[0]?.host, "fe80::abcd%12", "an IPv4 socket knows its adapter's scope");
});

test("a link-local address heard on an interface with no known scope is not usable and is ignored", async () => {
  const { net, discovery } = setup([WIFI]);
  await discovery.start();
  net.on(WIFI.address).receive(announce({ id: "dddd0000000000000000000000000004", fn: "ll", aaaa: ["fe80::abcd"] }));
  assert.deepEqual(discovery.devices(), []);
});

test("IPv4 is preferred when a device has both", async () => {
  const { net, discovery } = setup([ETH, ETH6]);
  await discovery.start();
  net.on("10.0.0.5").receive(announce({ ...TV, aaaa: ["2001:db8::10"] }));
  const [d] = discovery.devices();
  assert.equal(d?.host, "10.0.0.10");
  assert.deepEqual(d?.addresses, ["10.0.0.10", "2001:db8::10"]);
});

test("a device that gets a new IP (DHCP) is updated in place, not duplicated, and the new address leads", async () => {
  const { net, discovery, events } = setup([ETH]);
  await discovery.start();
  net.on(ETH.address).receive(announce(TV));
  await advance(5000);
  // The device announces the new address without the cache-flush bit, so the old record is still in the cache.
  net.on(ETH.address).receive(announce({ ...TV, addr: "10.0.0.77" }, { cacheFlush: false }));
  assert.deepEqual(events.map((e) => e.type), ["deviceUp", "deviceChanged"]);
  assert.equal(discovery.devices().length, 1);
  assert.equal(discovery.devices()[0]?.host, "10.0.0.77");
  // With the cache-flush bit the old addresses are dropped altogether.
  await advance(5000);
  net.on(ETH.address).receive(announce({ ...TV, addr: "10.0.0.78" }));
  assert.equal(discovery.devices().length, 1);
  assert.deepEqual(discovery.devices()[0]?.addresses, ["10.0.0.78"]);
});

test("a goodbye (TTL 0) for the A record removes only that address", async () => {
  const { net, discovery, events } = setup([ETH]);
  await discovery.start();
  net.on(ETH.address).receive(announce({ ...TV, aaaa: ["2001:db8::10"] }));
  const bye = Buffer.concat([header({ an: 1 }), rr(`${TV.id}.local`, RecordType.A, 0x8001, 0, Buffer.from([10, 0, 0, 10]))]);
  net.on(ETH.address).receive(bye);
  assert.deepEqual(discovery.devices()[0]?.addresses, ["2001:db8::10"]);
  assert.deepEqual(events.map((e) => e.type), ["deviceUp", "deviceChanged"]);
});

test("a changed TXT record is deviceChanged", async () => {
  const { net, discovery, events } = setup();
  await discovery.start();
  net.on(ETH.address).receive(announce(TV));
  await advance(5000);
  net.on(ETH.address).receive(announce({ ...TV, fn: "Den TV" }));
  assert.deepEqual(events, [
    { type: "deviceUp", id: TV.id, name: "Lounge TV" },
    { type: "deviceChanged", id: TV.id, name: "Den TV" },
  ]);
  assert.equal(discovery.devices()[0]?.name, "Den TV");
});

test("a goodbye takes the device down at once", async () => {
  const { net, discovery, events } = setup();
  await discovery.start();
  net.on(ETH.address).receive(announce(TV));
  net.on(ETH.address).receive(goodbye(TV.id));
  assert.deepEqual(events.map((e) => e.type), ["deviceUp", "deviceDown"]);
  assert.deepEqual(discovery.devices(), []);
});

test("a device that stops answering goes down when its records expire", async () => {
  const { net, discovery, events } = setup();
  await discovery.start();
  net.on(ETH.address).receive(announce(TV));
  await advance(119_000);
  assert.equal(events.filter((e) => e.type === "deviceDown").length, 0);
  await advance(2000);
  assert.deepEqual(events.filter((e) => e.type === "deviceDown"), [{ type: "deviceDown", id: TV.id, name: "Lounge TV" }]);
  assert.deepEqual(discovery.devices(), []);
});

test("answers keep a device alive past its first TTL", async () => {
  const { net, discovery, events } = setup();
  await discovery.start();
  net.on(ETH.address).receive(announce(TV));
  await advance(100_000);
  net.on(ETH.address).receive(announce(TV));
  await advance(100_000);
  assert.equal(events.filter((e) => e.type === "deviceDown").length, 0);
  assert.equal(discovery.devices().length, 1);
});

test("events from one packet come down, then changed, then up", async () => {
  const { net, discovery, events } = setup();
  await discovery.start();
  net.on(ETH.address).receive(announce(TV));
  net.on(ETH.address).receive(announce(SPEAKER));
  await advance(5000);
  events.length = 0;
  net.on(ETH.address).receive(mixed(TV.id, SPEAKER.id, "Office speaker", HUB));
  assert.deepEqual(events, [
    { type: "deviceDown", id: TV.id, name: "Lounge TV" },
    { type: "deviceChanged", id: SPEAKER.id, name: "Office speaker" },
    { type: "deviceUp", id: HUB.id, name: "Kitchen display" },
  ]);
});

test("queries (even with answers) and malformed packets are ignored", async () => {
  const { net, discovery, events, errors } = setup();
  await discovery.start();
  const s = net.on(ETH.address);
  s.receive(announce({ ...TV, flags: 0 })); // a query carrying known answers
  s.receive(Buffer.from([1, 2, 3]));
  s.receive(announce(TV).subarray(0, 40));
  assert.deepEqual(events, []);
  assert.deepEqual(errors, []);
  s.receive(announce(TV));
  assert.equal(events.length, 1);
});

test("devices() returns copies", async () => {
  const { net, discovery } = setup();
  await discovery.start();
  net.on(ETH.address).receive(announce(TV));
  const [d] = discovery.devices();
  assert.ok(d);
  d.name = "mutated";
  d.addresses.push("1.2.3.4");
  assert.equal(discovery.devices()[0]?.name, "Lounge TV");
  assert.deepEqual(discovery.devices()[0]?.addresses, ["10.0.0.10"]);
});

// ---------------------------------------------------------------------------------------------------------------
// Interface changes and socket failures

test("an interface that fails to open is reported, and the others still work", async () => {
  const { net, discovery, errors } = setup([ETH, WIFI]);
  net.failOpen.set(ETH.address, new Error("EADDRNOTAVAIL"));
  await discovery.start();
  assert.deepEqual(errors, [{ address: ETH.address, message: "EADDRNOTAVAIL" }]);
  assert.deepEqual(net.on(WIFI.address).sent, [QUERY]);
  assert.deepEqual(discovery.interfaces(), [WIFI]);
});

test("a failed interface is retried at the next interface check (10 s) and queried at once", async () => {
  const { net, discovery } = setup([ETH, WIFI]);
  net.failOpen.set(ETH.address, new Error("EADDRNOTAVAIL"));
  await discovery.start();
  net.failOpen.clear();
  await advance(9_999);
  assert.deepEqual(net.attempts, [ETH.address, WIFI.address]);
  await advance(1);
  assert.deepEqual(net.attempts, [ETH.address, WIFI.address, ETH.address]);
  assert.deepEqual(net.on(ETH.address).sent, [QUERY]);
  assert.deepEqual(discovery.interfaces(), [WIFI, ETH]);
});

test("new interfaces are opened and queried; vanished ones are closed; unchanged ones are left alone", async () => {
  const { net, discovery } = setup([ETH, WIFI]);
  await discovery.start();
  const wifi = net.on(WIFI.address);
  net.ifaces = [ETH, WSL];
  await advance(10_000);
  assert.deepEqual(net.attempts, [ETH.address, WIFI.address, WSL.address]);
  assert.equal(wifi.closed, true);
  assert.deepEqual(net.on(WSL.address).sent, [QUERY]);
  assert.deepEqual(discovery.interfaces(), [ETH, WSL]);
  await advance(10_000);
  assert.deepEqual(net.attempts, [ETH.address, WIFI.address, WSL.address]);
});

test("devices heard only on an interface that goes away are removed at once; others stay", async () => {
  const { net, discovery, events } = setup([ETH, WIFI]);
  await discovery.start();
  net.on(ETH.address).receive(announce(TV));
  net.on(WIFI.address).receive(announce(SPEAKER));
  net.on(ETH.address).receive(announce(HUB));
  net.on(WIFI.address).receive(announce(HUB));
  events.length = 0;
  net.ifaces = [WIFI];
  await advance(10_000);
  assert.deepEqual(events, [{ type: "deviceDown", id: TV.id, name: "Lounge TV" }]);
  assert.deepEqual(discovery.devices().map((d) => d.id), [HUB.id, SPEAKER.id]);
});

test("an interface whose socket had already failed still drops its devices when it disappears", async () => {
  const { net, discovery, events } = setup([ETH, WIFI]);
  await discovery.start();
  net.on(ETH.address).receive(announce(TV));
  net.on(ETH.address).handlers.error(new Error("ENETDOWN"));
  events.length = 0;
  net.ifaces = [WIFI];
  await advance(10_000);
  assert.deepEqual(events, [{ type: "deviceDown", id: TV.id, name: "Lounge TV" }]);
});

test("an IPv6 interface that cannot be opened is reported once and IPv4 carries on", async () => {
  const { net, discovery, errors } = setup([ETH, ETH6]);
  net.failOpen.set(ETH6.address, new Error("EADDRNOTAVAIL ff02::fb"));
  await discovery.start();
  assert.deepEqual(errors, [{ address: "fe80::5", message: "EADDRNOTAVAIL ff02::fb" }]);
  assert.deepEqual(discovery.interfaces(), [ETH]);
  for (let i = 0; i < 3; i++) await advance(10_000);
  assert.equal(net.attempts.filter((a) => a === "fe80::5").length, 4, "retried at every check");
  assert.equal(errors.length, 1, "but reported once");
  net.on(ETH.address).receive(announce(TV));
  assert.equal(discovery.devices().length, 1);
  net.failOpen.clear();
  await advance(10_000);
  assert.deepEqual(discovery.interfaces(), [ETH, ETH6]);
});

test("the same link-local address on two adapters is two interfaces", async () => {
  const { net, discovery } = setup([ETH6, WIFI6]);
  await discovery.start();
  assert.deepEqual(discovery.interfaces(), [ETH6, WIFI6]);
  net.ifaces = [WIFI6];
  await advance(10_000);
  assert.deepEqual(discovery.interfaces(), [WIFI6]);
});

test("after a long gap between interface checks (sleep and resume) the sockets are replaced and queried", async () => {
  const { net, discovery } = setup([ETH]);
  await discovery.start();
  const before = net.on(ETH.address);
  // A sleeping machine runs no timers: jump the clock without ticking them.
  mock.timers.setTime(5 * 60_000);
  await advance(10_000);
  assert.equal(before.closed, true);
  const fresh = net.on(ETH.address);
  assert.notEqual(fresh, before);
  assert.deepEqual(fresh.sent, [QUERY]);
});

test("the interface check interval can be configured", async () => {
  const { net, discovery } = setup([ETH], { interfaceCheckMs: 2000 });
  await discovery.start();
  net.ifaces = [ETH, WIFI];
  await advance(2000);
  assert.deepEqual(net.attempts, [ETH.address, WIFI.address]);
});

test("a socket error is reported, that socket is closed, and it is reopened at the next check", async () => {
  const { net, discovery, errors } = setup([ETH, WIFI]);
  await discovery.start();
  const eth = net.on(ETH.address);
  eth.handlers.error(new Error("ENETDOWN"));
  assert.deepEqual(errors, [{ address: ETH.address, message: "ENETDOWN" }]);
  assert.equal(eth.closed, true);
  assert.deepEqual(discovery.interfaces(), [WIFI]);
  discovery.query();
  assert.equal(eth.sent.length, 1, "no query on the failed socket");
  await advance(10_000);
  assert.notEqual(net.on(ETH.address), eth);
  assert.deepEqual(net.on(ETH.address).sent, [QUERY]);
});

test("a late error from a replaced socket does not close the socket that replaced it", async () => {
  const { net, discovery, errors } = setup([ETH]);
  await discovery.start();
  const old = net.on(ETH.address);
  old.handlers.error(new Error("ENETDOWN"));
  await advance(10_000);
  const fresh = net.on(ETH.address);
  assert.notEqual(fresh, old);
  old.handlers.error(new Error("late"));
  assert.equal(fresh.closed, false);
  assert.deepEqual(discovery.interfaces(), [ETH]);
  assert.deepEqual(errors.map((e) => e.message), ["ENETDOWN"]);
});

test("a send that throws is reported as a socket error, not thrown", async () => {
  const { net, discovery, errors } = setup([ETH]);
  await discovery.start();
  const eth = net.on(ETH.address);
  eth.send = () => {
    throw new Error("EHOSTUNREACH");
  };
  assert.doesNotThrow(() => discovery.query());
  assert.deepEqual(errors, [{ address: ETH.address, message: "EHOSTUNREACH" }]);
  assert.equal(eth.closed, true);
});

// ---------------------------------------------------------------------------------------------------------------
// stop

test("stop closes every socket, stops all timers and events, and forgets devices", async () => {
  const { net, discovery, events } = setup([ETH, WIFI]);
  await discovery.start();
  net.on(ETH.address).receive(announce(TV));
  const sockets = [...net.sockets];
  discovery.stop();
  assert.ok(sockets.every((s) => s.closed));
  assert.deepEqual(discovery.devices(), []);
  assert.deepEqual(discovery.interfaces(), []);
  const before = events.length;
  sockets[0]?.receive(announce(SPEAKER));
  net.ifaces = [ETH, WIFI, WSL];
  await advance(300_000);
  assert.equal(events.length, before);
  assert.deepEqual(net.attempts, [ETH.address, WIFI.address]);
  assert.ok(sockets.every((s) => s.sent.length === 1));
  assert.doesNotThrow(() => discovery.stop());
});

test("a socket that finishes opening after stop is closed at once", async () => {
  const net = new FakeNet([ETH]);
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const opened: FakeSocket[] = [];
  const discovery = new CastDiscovery({
    interfaces: net.interfaces,
    openSocket: async (iface, handlers) => {
      await gate;
      const s = new FakeSocket(iface, handlers);
      opened.push(s);
      return s;
    },
  });
  const started = discovery.start();
  discovery.stop();
  release();
  await started;
  assert.equal(opened.length, 1);
  assert.equal(opened[0]?.closed, true);
  assert.deepEqual(opened[0]?.sent, []);
});

test("start after stop rejects", async () => {
  const { discovery } = setup();
  await discovery.start();
  discovery.stop();
  await assert.rejects(discovery.start(), /stopped/);
});
