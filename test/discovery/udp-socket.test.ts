import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type dgram from "node:dgram";
import { openUdpMdnsSocket, MDNS_GROUP, MDNS_GROUP_V6, MDNS_PORT } from "../../src/discovery/udp-socket.ts";
import type { MdnsSocketHandlers } from "../../src/discovery/cast-discovery.ts";

const IFACE = { name: "Ethernet", address: "10.0.0.5" };

type Fail = "bind" | "addMembership" | "setMulticastInterface";

/** Records what the code under test does with each dgram socket. */
class FakeUdp extends EventEmitter {
  readonly options: dgram.SocketOptions;
  calls: string[] = [];
  sent: { packet: Buffer; port: number; address: string }[] = [];
  closed = false;
  fail: Map<Fail, Error>;
  sendError: Error | null = null;

  constructor(options: dgram.SocketOptions, fail: Map<Fail, Error>) {
    super();
    this.options = options;
    this.fail = fail;
  }

  bind(options: dgram.BindOptions, callback?: () => void): this {
    this.calls.push(`bind ${options.port} ${options.address ?? "*"}${options.exclusive === false ? " shared" : ""}`);
    const err = this.fail.get("bind");
    setImmediate(() => (err ? this.emit("error", err) : callback?.()));
    return this;
  }
  addMembership(group: string, iface?: string): void {
    this.calls.push(`addMembership ${group} ${iface}`);
    const err = this.fail.get("addMembership");
    if (err) throw err;
  }
  setMulticastInterface(iface: string): void {
    this.calls.push(`setMulticastInterface ${iface}`);
    const err = this.fail.get("setMulticastInterface");
    if (err) throw err;
  }
  setMulticastTTL(ttl: number): number {
    this.calls.push(`setMulticastTTL ${ttl}`);
    return ttl;
  }
  setMulticastLoopback(flag: boolean): boolean {
    this.calls.push(`setMulticastLoopback ${flag}`);
    return flag;
  }
  send(packet: Buffer, port: number, address: string, callback?: (err: Error | null) => void): void {
    this.sent.push({ packet, port, address });
    const err = this.sendError;
    setImmediate(() => callback?.(err));
  }
  close(): this {
    this.calls.push("close");
    if (this.closed) throw new Error("ERR_SOCKET_DGRAM_NOT_RUNNING");
    this.closed = true;
    return this;
  }
}

function harness(failFirst: [Fail, Error][] = [], failSecond: [Fail, Error][] = []) {
  const created: FakeUdp[] = [];
  const plans = [new Map(failFirst), new Map(failSecond)];
  const createSocket = (options: dgram.SocketOptions) => {
    const s = new FakeUdp(options, plans[created.length] ?? new Map());
    created.push(s);
    return s as unknown as dgram.Socket;
  };
  const messages: { packet: Buffer; from: { address: string; port: number } }[] = [];
  const errors: string[] = [];
  const handlers: MdnsSocketHandlers = {
    message: (packet, from) => messages.push({ packet, from }),
    error: (e) => errors.push(e.message),
  };
  return { created, createSocket, handlers, messages, errors };
}

const tick = () => new Promise((r) => setImmediate(r));
const inUse = () => Object.assign(new Error("bind EADDRINUSE 0.0.0.0:5353"), { code: "EADDRINUSE" });

test("constants", () => {
  assert.equal(MDNS_GROUP, "224.0.0.251");
  assert.equal(MDNS_PORT, 5353);
});

test("multicast mode: a shared socket on port 5353 that joins the group on this interface only", async () => {
  const h = harness();
  const sock = await openUdpMdnsSocket(IFACE, h.handlers, { createSocket: h.createSocket });
  assert.equal(sock.mode, "multicast");
  assert.equal(h.created.length, 1);
  const [s] = h.created;
  assert.deepEqual(s?.options, { type: "udp4", reuseAddr: true });
  assert.deepEqual(s?.calls, [
    "bind 5353 * shared",
    "addMembership 224.0.0.251 10.0.0.5",
    "setMulticastInterface 10.0.0.5",
    "setMulticastTTL 255",
    "setMulticastLoopback false",
  ]);
});

test("send goes to the mDNS group and port", async () => {
  const h = harness();
  const sock = await openUdpMdnsSocket(IFACE, h.handlers, { createSocket: h.createSocket });
  const packet = Buffer.from([1, 2, 3]);
  sock.send(packet);
  assert.deepEqual(h.created[0]?.sent, [{ packet, port: 5353, address: "224.0.0.251" }]);
});

test("a failed send is reported through handlers.error", async () => {
  const h = harness();
  const sock = await openUdpMdnsSocket(IFACE, h.handlers, { createSocket: h.createSocket });
  const s = h.created[0];
  assert.ok(s);
  s.sendError = new Error("EHOSTUNREACH");
  sock.send(Buffer.from([1]));
  await tick();
  assert.deepEqual(h.errors, ["EHOSTUNREACH"]);
});

test("incoming packets and socket errors reach the handlers", async () => {
  const h = harness();
  await openUdpMdnsSocket(IFACE, h.handlers, { createSocket: h.createSocket });
  const s = h.created[0];
  assert.ok(s);
  const packet = Buffer.from([9, 9]);
  s.emit("message", packet, { address: "10.0.0.10", port: 5353, family: "IPv4", size: 2 });
  s.emit("error", new Error("ENETDOWN"));
  assert.deepEqual(h.messages, [{ packet, from: { address: "10.0.0.10", port: 5353 } }]);
  assert.deepEqual(h.errors, ["ENETDOWN"]);
});

test("close closes the socket once and can be called again", async () => {
  const h = harness();
  const sock = await openUdpMdnsSocket(IFACE, h.handlers, { createSocket: h.createSocket });
  sock.close();
  assert.doesNotThrow(() => sock.close());
  assert.equal(h.created[0]?.closed, true);
  assert.equal(h.created[0]?.calls.filter((c) => c === "close").length, 1);
});

test("port 5353 in use: falls back to a unicast socket bound to the interface address", async () => {
  const h = harness([["bind", inUse()]]);
  const sock = await openUdpMdnsSocket(IFACE, h.handlers, { createSocket: h.createSocket });
  assert.equal(sock.mode, "unicast");
  assert.equal(h.created.length, 2);
  const [first, second] = h.created;
  assert.equal(first?.closed, true, "the failed socket is closed");
  assert.deepEqual(second?.options, { type: "udp4" });
  assert.deepEqual(second?.calls, ["bind 0 10.0.0.5", "setMulticastInterface 10.0.0.5", "setMulticastTTL 255"]);
  sock.send(Buffer.from([1]));
  assert.deepEqual(second?.sent.map((x) => `${x.address}:${x.port}`), ["224.0.0.251:5353"]);
  second?.emit("message", Buffer.from([7]), { address: "10.0.0.10", port: 5353, family: "IPv4", size: 1 });
  assert.equal(h.messages.length, 1);
});

test("joining the group fails: also falls back to unicast", async () => {
  const h = harness([["addMembership", new Error("EADDRNOTAVAIL")]]);
  const sock = await openUdpMdnsSocket(IFACE, h.handlers, { createSocket: h.createSocket });
  assert.equal(sock.mode, "unicast");
  assert.equal(h.created[0]?.closed, true);
});

test("errors during setup are not reported through handlers.error", async () => {
  const h = harness([["bind", inUse()]]);
  await openUdpMdnsSocket(IFACE, h.handlers, { createSocket: h.createSocket });
  assert.deepEqual(h.errors, []);
});

test("both modes fail: rejects with the unicast error and leaves no socket open", async () => {
  const h = harness([["bind", inUse()]], [["setMulticastInterface", new Error("EINVAL")]]);
  await assert.rejects(openUdpMdnsSocket(IFACE, h.handlers, { createSocket: h.createSocket }), /EINVAL/);
  assert.equal(h.created.length, 2);
  assert.ok(h.created.every((s) => s.closed));
});

test("uses node:dgram by default", async () => {
  // Binds a real socket on loopback; multicast setup may fail there, and a sandbox may have no UDP at all.
  let sock: Awaited<ReturnType<typeof openUdpMdnsSocket>>;
  try {
    sock = await openUdpMdnsSocket({ name: "loopback", address: "127.0.0.1" }, { message: () => {}, error: () => {} });
  } catch {
    return; // the fakes above cover the logic
  }
  assert.ok(sock.mode === "multicast" || sock.mode === "unicast");
  sock.close();
});

const IFACE6 = { name: "Ethernet", address: "fe80::5", family: "IPv6" as const, scopeId: 12 };

test("IPv6 multicast mode: an ipv6-only udp6 socket on 5353 that joins ff02::fb on this interface's scope", async () => {
  const h = harness();
  const sock = await openUdpMdnsSocket(IFACE6, h.handlers, { createSocket: h.createSocket });
  assert.equal(sock.mode, "multicast");
  assert.equal(MDNS_GROUP_V6, "ff02::fb");
  const [s] = h.created;
  assert.deepEqual(s?.options, { type: "udp6", reuseAddr: true, ipv6Only: true });
  assert.deepEqual(s?.calls, [
    "bind 5353 * shared",
    "addMembership ff02::fb fe80::5%12",
    "setMulticastInterface ::%12",
    "setMulticastTTL 255",
    "setMulticastLoopback false",
  ]);
  sock.send(Buffer.from([1]));
  assert.deepEqual(s?.sent.map((x) => `${x.address}:${x.port}`), ["ff02::fb:5353"]);
});

test("IPv6 with port 5353 in use: unicast socket bound to the scoped link-local address, still sending to ff02::fb", async () => {
  const h = harness([["bind", inUse()]]);
  const sock = await openUdpMdnsSocket(IFACE6, h.handlers, { createSocket: h.createSocket });
  assert.equal(sock.mode, "unicast");
  const [first, second] = h.created;
  assert.equal(first?.closed, true);
  assert.deepEqual(second?.options, { type: "udp6", ipv6Only: true });
  assert.deepEqual(second?.calls, ["bind 0 fe80::5%12", "setMulticastInterface ::%12", "setMulticastTTL 255"]);
  sock.send(Buffer.from([1]));
  assert.deepEqual(second?.sent.map((x) => `${x.address}:${x.port}`), ["ff02::fb:5353"]);
});

test("IPv6 unavailable (both modes fail): rejects and leaves no socket open", async () => {
  const h = harness([["bind", new Error("EAFNOSUPPORT")]], [["bind", new Error("EAFNOSUPPORT")]]);
  await assert.rejects(openUdpMdnsSocket(IFACE6, h.handlers, { createSocket: h.createSocket }), /EAFNOSUPPORT/);
  assert.ok(h.created.every((s) => s.closed));
});
