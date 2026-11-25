import { test } from "node:test";
import assert from "node:assert/strict";
import { CastDeviceCache, type CastDevice } from "../../src/discovery/device-cache.ts";
import { decodeDnsPacket, type DnsRecord } from "../../src/discovery/dns-packet.ts";
import { fixture } from "./helpers.ts";

const SERVICE = "_googlecast._tcp.local";

function records(name: "chromecast" | "home-mini" | "fuchsia-hub-max-groups"): DnsRecord[] {
  const p = decodeDnsPacket(fixture(name));
  return [...p.answers, ...p.authorities, ...p.additionals];
}

function allFixtures(): DnsRecord[] {
  return [...records("chromecast"), ...records("home-mini"), ...records("fuchsia-hub-max-groups")];
}

const ids = (list: CastDevice[]) => list.map((d) => d.id);

const LOUNGE: Partial<CastDevice> = {
  id: "afdd4ab851bc954c170d37581867bf54",
  name: "Lounge Cast TV",
  model: "Chromecast",
  host: "10.0.0.10",
  addresses: ["10.0.0.10"],
  port: 8009,
  capabilities: 464901,
  isGroup: false,
  statusText: "",
  instanceName: "Chromecast-afdd4ab851bc954c170d37581867bf54._googlecast._tcp.local",
};

test("joins PTR, SRV, TXT and A into devices", () => {
  const cache = new CastDeviceCache();
  cache.ingest(records("chromecast"), 0);
  const [d] = cache.devices();
  assert.equal(cache.devices().length, 1);
  for (const [k, v] of Object.entries(LOUNGE)) assert.deepEqual(d?.[k as keyof CastDevice], v, k);
  assert.equal(d?.txt.md, "Chromecast");
  assert.equal(d?.txt.ve, "05");
});

test("finds all five devices across the fixtures, sorted by name then id", () => {
  const cache = new CastDeviceCache();
  cache.ingest(allFixtures(), 0);
  const list = cache.devices();
  assert.deepEqual(list.map((d) => [d.name, d.port, d.host, d.isGroup]), [
    ["Everywhere", 32200, "10.0.0.30", true],
    ["Hallway display", 8009, "10.0.0.30", false],
    ["Lounge Cast TV", 8009, "10.0.0.10", false],
    ["Study Room speaker", 8009, "10.0.0.20", false],
    ["Upstairs group", 32044, "10.0.0.30", true],
  ]);
  const group = list.find((d) => d.name === "Upstairs group");
  assert.equal(group?.id, "05f026bd-12a7-7cf7-25b7-b0b60b40087c");
  assert.equal(group?.model, "Google Cast Group");
  assert.equal(group?.capabilities, 199204);
  const mini = list.find((d) => d.name === "Study Room speaker");
  assert.equal(mini?.capabilities, 199172);
  assert.equal((mini?.capabilities ?? 0) & 1, 0, "Home Mini has no video out");
});

test("lists IPv4 addresses before IPv6, keeping every address in the same packet", () => {
  const cache = new CastDeviceCache();
  cache.ingest(records("fuchsia-hub-max-groups"), 0);
  const hub = cache.devices().find((d) => d.name === "Hallway display");
  assert.deepEqual(hub?.addresses, ["10.0.0.30", "fd00::4", "fd00::5", "fd00::6", "fd00::7"]);
  assert.equal(hub?.host, "10.0.0.30");
});

test("uses an IPv6 host when there is no IPv4 address", () => {
  const cache = new CastDeviceCache();
  cache.ingest(records("fuchsia-hub-max-groups").filter((r) => r.type !== "A"), 0);
  assert.equal(cache.devices().find((d) => d.name === "Hallway display")?.host, "fd00::4");
});

test("ingest reports added devices once, then nothing for an identical repeat", () => {
  const cache = new CastDeviceCache();
  const first = cache.ingest(records("chromecast"), 0);
  assert.deepEqual(ids(first.added), [LOUNGE.id]);
  assert.deepEqual(first.updated, []);
  assert.deepEqual(first.removed, []);
  const again = cache.ingest(records("chromecast"), 1000);
  assert.deepEqual(again, { added: [], updated: [], removed: [] });
});

test("an incomplete device appears only once the missing records arrive", () => {
  const cache = new CastDeviceCache();
  const all = records("chromecast");
  const ptrSrv = all.filter((r) => r.type === "PTR" || r.type === "SRV");
  const rest = all.filter((r) => r.type !== "PTR" && r.type !== "SRV");
  assert.deepEqual(cache.ingest(ptrSrv, 0).added, []);
  assert.deepEqual(cache.devices(), []);
  assert.deepEqual(ids(cache.ingest(rest, 10).added), [LOUNGE.id]);
});

test("a device needs a TXT id", () => {
  const cache = new CastDeviceCache();
  const noId = records("chromecast").map((r) => {
    if (r.type !== "TXT") return r;
    const data = Object.assign(Object.create(null), r.data) as Record<string, string>;
    delete data.id;
    return { ...r, data };
  });
  cache.ingest(noId, 0);
  assert.deepEqual(cache.devices(), []);
});

test("a TXT change is reported as updated", () => {
  const cache = new CastDeviceCache();
  cache.ingest(records("chromecast"), 0);
  const renamed = records("chromecast").map((r) =>
    r.type === "TXT" ? { ...r, data: Object.assign(Object.create(null), r.data, { fn: "Den TV", rs: "YouTube Music" }) } : r,
  );
  const change = cache.ingest(renamed, 1000);
  assert.deepEqual(change.added, []);
  assert.deepEqual(change.removed, []);
  assert.equal(change.updated.length, 1);
  assert.equal(change.updated[0]?.name, "Den TV");
  assert.equal(change.updated[0]?.statusText, "YouTube Music");
  assert.equal(cache.devices()[0]?.name, "Den TV");
});

test("records expire after their TTL", () => {
  const cache = new CastDeviceCache();
  cache.ingest(records("chromecast"), 0);
  assert.deepEqual(cache.expire(119_999), { added: [], updated: [], removed: [] });
  assert.equal(cache.devices().length, 1);
  const gone = cache.expire(120_000);
  assert.deepEqual(ids(gone.removed), [LOUNGE.id]);
  assert.deepEqual(cache.devices(), []);
});

test("a fresh copy of a record extends its lifetime", () => {
  const cache = new CastDeviceCache();
  cache.ingest(records("chromecast"), 0);
  cache.ingest(records("chromecast"), 100_000);
  cache.expire(150_000);
  assert.equal(cache.devices().length, 1);
  assert.deepEqual(ids(cache.expire(220_000).removed), [LOUNGE.id]);
});

test("a TTL-0 goodbye removes the device in the same ingest", () => {
  const cache = new CastDeviceCache();
  cache.ingest(records("chromecast"), 0);
  const ptr = records("chromecast").find((r) => r.type === "PTR");
  assert.ok(ptr);
  const bye = cache.ingest([{ ...ptr, ttl: 0 }], 5000);
  assert.deepEqual(ids(bye.removed), [LOUNGE.id]);
  assert.deepEqual(cache.devices(), []);
});

test("cache-flush replaces older records of the same name and type, not the same packet's", () => {
  const cache = new CastDeviceCache();
  cache.ingest(records("fuchsia-hub-max-groups"), 0);
  const host = "fuchsia-3769-c26f-b9bb.local";
  const moved: DnsRecord = { name: host, type: "A", rclass: 1, cacheFlush: true, ttl: 120, data: "10.0.0.31" };
  const change = cache.ingest([moved], 5000);
  assert.equal(change.updated.length, 3, "all three devices on that host changed address");
  const hub = cache.devices().find((d) => d.name === "Hallway display");
  assert.deepEqual(hub?.addresses, ["10.0.0.31", "fd00::4", "fd00::5", "fd00::6", "fd00::7"]);
});

test("cache-flush does not evict records received within the last second", () => {
  const cache = new CastDeviceCache();
  cache.ingest(records("fuchsia-hub-max-groups"), 0);
  const host = "fuchsia-3769-c26f-b9bb.local";
  cache.ingest([{ name: host, type: "A", rclass: 1, cacheFlush: true, ttl: 120, data: "10.0.0.31" }], 500);
  const hub = cache.devices().find((d) => d.name === "Hallway display");
  assert.deepEqual(hub?.addresses.filter((a) => a.startsWith("10.")), ["10.0.0.31", "10.0.0.30"]);
});

test("ignores PTR records for other services", () => {
  const cache = new CastDeviceCache();
  const other = records("chromecast").map((r) => (r.type === "PTR" ? { ...r, name: "_spotify-connect._tcp.local" } : r));
  cache.ingest(other, 0);
  assert.deepEqual(cache.devices(), []);
});

test("matches names case-insensitively", () => {
  const cache = new CastDeviceCache();
  const shouty = records("chromecast").map((r) =>
    r.type === "SRV" || r.type === "TXT" ? { ...r, name: r.name.toUpperCase() } : r,
  );
  cache.ingest(shouty, 0);
  assert.equal(cache.devices().length, 1);
  assert.equal(cache.devices()[0]?.instanceName, LOUNGE.instanceName, "instance name comes from the PTR data");
});

test("two instances with the same TXT id collapse to the most recently refreshed one", () => {
  const cache = new CastDeviceCache();
  cache.ingest(records("chromecast"), 0);
  const alias = "Chromecast-alias._googlecast._tcp.local";
  const copy = records("chromecast").map((r) => {
    if (r.type === "PTR") return { ...r, data: alias };
    if (r.type === "SRV") return { ...r, name: alias, data: { ...r.data, port: 8010 } };
    if (r.type === "TXT") return { ...r, name: alias };
    return r;
  });
  cache.ingest(copy, 1000);
  const list = cache.devices();
  assert.equal(list.length, 1);
  assert.equal(list[0]?.port, 8010);
  assert.equal(list[0]?.instanceName, alias);
});

test("falls back to the instance label when fn is missing, and to 0 for a bad ca", () => {
  const cache = new CastDeviceCache();
  const bare = records("chromecast").map((r) => {
    if (r.type !== "TXT") return r;
    const data = Object.assign(Object.create(null), r.data) as Record<string, string>;
    delete data.fn;
    data.ca = "not-a-number";
    return { ...r, data };
  });
  cache.ingest(bare, 0);
  const [d] = cache.devices();
  assert.equal(d?.name, "Chromecast-afdd4ab851bc954c170d37581867bf54");
  assert.equal(d?.capabilities, 0);
  assert.equal(d?.isGroup, false);
});

test("a custom service name can be watched", () => {
  const cache = new CastDeviceCache("_custom._tcp.local");
  const custom = records("chromecast").map((r) => (r.type === "PTR" ? { ...r, name: "_custom._tcp.local" } : r));
  cache.ingest(custom, 0);
  assert.equal(cache.devices().length, 1);
  assert.equal(new CastDeviceCache().serviceName, SERVICE);
});

test("returned devices are snapshots the caller cannot use to corrupt the cache", () => {
  const cache = new CastDeviceCache();
  cache.ingest(records("chromecast"), 0);
  const [d] = cache.devices();
  assert.ok(d);
  d.addresses.push("1.2.3.4");
  d.txt.fn = "hacked";
  assert.deepEqual(cache.devices()[0]?.addresses, ["10.0.0.10"]);
  assert.equal(cache.devices()[0]?.txt.fn, "Lounge Cast TV");
});

function host(name: string, type: "A" | "AAAA", data: string, ttl = 120, cacheFlush = true): DnsRecord {
  return { name, type, ttl, cacheFlush, data } as DnsRecord;
}

test("dropSource removes records only that source heard, keeps those another source also heard", () => {
  const cache = new CastDeviceCache();
  const all = records("chromecast");
  cache.ingest(all, 0, "eth");
  cache.ingest(all.filter((r) => r.type === "PTR" || r.type === "TXT"), 1000, "wifi");
  // Everything came from eth; the PTR and TXT also from wifi. Losing wifi changes nothing.
  assert.deepEqual(cache.dropSource("wifi"), { added: [], updated: [], removed: [] });
  assert.equal(cache.devices().length, 1);
  // Losing eth removes the SRV and A records, so the device cannot be joined any more.
  const change = cache.dropSource("eth");
  assert.equal(change.removed.length, 1);
  assert.deepEqual(cache.devices(), []);
});

test("records ingested without a source are never dropped by dropSource", () => {
  const cache = new CastDeviceCache();
  cache.ingest(records("chromecast"), 0);
  assert.deepEqual(cache.dropSource("eth"), { added: [], updated: [], removed: [] });
  assert.equal(cache.devices().length, 1);
});

test("addresses: IPv4 first, then global IPv6, then link-local; newest first within a kind", () => {
  const cache = new CastDeviceCache();
  const base = records("chromecast");
  const target = base.find((r) => r.type === "A")?.name ?? "";
  cache.ingest(base.filter((r) => r.type !== "A"), 0);
  cache.ingest([host(target, "AAAA", "fe80::1%12")], 0);
  cache.ingest([host(target, "AAAA", "2001:db8::1")], 0);
  cache.ingest([host(target, "A", "10.0.0.10", 120, false)], 1000);
  cache.ingest([host(target, "A", "10.0.0.77", 120, false)], 2000);
  const [d] = cache.devices();
  assert.deepEqual(d?.addresses, ["10.0.0.77", "10.0.0.10", "2001:db8::1", "fe80::1%12"]);
  assert.equal(d?.host, "10.0.0.77");
});
