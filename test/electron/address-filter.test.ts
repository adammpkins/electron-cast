import { test } from "node:test";
import assert from "node:assert/strict";
import type { EventEmitter } from "node:events";
import type { CastDevice } from "../../src/discovery/index.ts";
import { withAddressPolicy, restrictDevice } from "../../src/electron/address-filter.ts";
import { createCastManager, type IpcMainLike } from "../../src/electron/main.ts";
import { FakeDevices, FakeClient, TV, device, FAST_SINKS } from "./fakes.ts";

const PUBLIC = device({ id: "dev-public", name: "Public", host: "8.8.8.8", addresses: ["8.8.8.8"] });
const LOOPBACK = device({ id: "dev-loop", name: "Loop", host: "127.0.0.1", addresses: ["127.0.0.1"] });

test("devices at publicly routable or loopback addresses are hidden by default", () => {
  const src = new FakeDevices([TV, PUBLIC, LOOPBACK]);
  const filtered = withAddressPolicy(src, false);
  assert.deepEqual(filtered.devices().map((d) => d.id), ["dev-tv"]);
});

test("allowAllIPs returns the source untouched", () => {
  const src = new FakeDevices([TV, PUBLIC]);
  assert.equal(withAddressPolicy(src, true), src);
});

test("events follow the filtered list: refused devices never appear, a device that moves comes and goes", () => {
  const src = new FakeDevices([TV]);
  const filtered = withAddressPolicy(src, false);
  const seen: string[] = [];
  for (const e of ["deviceUp", "deviceDown", "deviceChanged"] as const) {
    filtered.on(e, (d: CastDevice) => seen.push(`${e}:${d.id}:${d.host}`));
  }
  src.up(PUBLIC);
  assert.deepEqual(seen, []);
  // the same device now announces a private address
  src.list = src.list.map((d) => (d.id === PUBLIC.id ? { ...d, host: "192.168.1.9", addresses: ["192.168.1.9"] } : d));
  (src as unknown as EventEmitter).emit("deviceChanged", src.list.find((d) => d.id === PUBLIC.id));
  assert.deepEqual(seen, ["deviceUp:dev-public:192.168.1.9"]);
  // and later a public one again
  src.list = src.list.map((d) => (d.id === PUBLIC.id ? { ...d, host: "8.8.4.4", addresses: ["8.8.4.4"] } : d));
  (src as unknown as EventEmitter).emit("deviceChanged", src.list.find((d) => d.id === PUBLIC.id));
  assert.deepEqual(seen.slice(1), ["deviceDown:dev-public:192.168.1.9"]);
  src.down(TV);
  assert.equal(seen.at(-1), "deviceDown:dev-tv:10.0.0.10");
});

test("a device with several addresses keeps its allowed ones, host first among them", () => {
  const multi = device({ id: "dev-multi", host: "8.8.8.8", addresses: ["8.8.8.8", "192.168.1.4", "fe80::1%3"] });
  const r = restrictDevice(multi, false);
  assert.deepEqual(r?.addresses, ["192.168.1.4", "fe80::1%3"]);
  assert.equal(r?.host, "192.168.1.4");
  assert.equal(restrictDevice(PUBLIC, false), null);
});

test("the other members of the source still run on the source", () => {
  class Source extends FakeDevices {
    started = 0;
    start(): Promise<void> {
      this.started++;
      return Promise.resolve();
    }
  }
  const src = new Source([TV]);
  const filtered = withAddressPolicy(src, false);
  void filtered.start();
  assert.equal(src.started, 1);
});

test("createCastManager hides refused devices unless allowAllIPs is set", async () => {
  const ipcMain = { handle() {}, removeHandler() {}, on() { return this; }, removeListener() { return this; } } as unknown as IpcMainLike;
  const make = (allowAllIPs?: boolean) =>
    createCastManager({
      ipcMain,
      sinks: FAST_SINKS,
      createClient: (d) => new FakeClient(d),
      discovery: Object.assign(new FakeDevices([TV, PUBLIC, LOOPBACK]), { start: async () => {}, stop: () => {} }),
      selectDevice: async () => null,
      ...(allowAllIPs === undefined ? {} : { allowAllIPs }),
    });
  const chrome = make();
  await chrome.settled();
  assert.deepEqual(chrome.devices().map((d) => d.id), ["dev-tv"]);
  const seen: string[][] = [];
  chrome.registerMediaSinksObserver({ onSinksUpdated: (s) => seen.push(s.map((x) => x.id)) });
  assert.deepEqual(seen, [["dev-tv"]]);
  await chrome.dispose();
  const open = make(true);
  await open.settled();
  assert.deepEqual(open.devices().map((d) => d.id), ["dev-tv", "dev-public", "dev-loop"]);
  await open.dispose();
});
