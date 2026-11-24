import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeDnsPacket, encodeMdnsQuery, formatIPv6, DnsFormatError, RecordType } from "../../src/discovery/dns-packet.ts";
import { fixture, dnsName, header, rr, txt } from "./helpers.ts";

const SERVICE = "_googlecast._tcp.local";
const CC = "Chromecast-afdd4ab851bc954c170d37581867bf54._googlecast._tcp.local";

test("RecordType codes", () => {
  assert.deepEqual(RecordType, { A: 1, PTR: 12, TXT: 16, AAAA: 28, SRV: 33 });
});

test("decodes the Chromecast reply fixture", () => {
  const p = decodeDnsPacket(fixture("chromecast"));
  assert.equal(p.id, 0);
  assert.equal(p.flags, 0x8400);
  assert.equal(p.isResponse, true);
  assert.deepEqual(p.questions, [{ name: SERVICE, type: 12, qclass: 1, unicastResponse: false }]);
  assert.deepEqual(p.answers, [{ name: SERVICE, type: "PTR", rclass: 1, cacheFlush: false, ttl: 120, data: CC }]);
  assert.equal(p.authorities.length, 0);
  assert.equal(p.additionals.length, 3);
  const [txtRec, srv, a] = p.additionals;
  assert.equal(txtRec?.type, "TXT");
  assert.equal(txtRec?.name, CC);
  assert.equal(txtRec?.ttl, 4500);
  if (txtRec?.type !== "TXT") throw new Error("unreachable");
  assert.equal(txtRec.data.id, "afdd4ab851bc954c170d37581867bf54");
  assert.equal(txtRec.data.fn, "Lounge Cast TV");
  assert.equal(txtRec.data.md, "Chromecast");
  assert.equal(txtRec.data.ca, "464901");
  assert.equal(txtRec.data.ic, "/setup/icon.png");
  assert.equal(txtRec.data.rs, "");
  assert.deepEqual(srv, {
    name: CC, type: "SRV", rclass: 1, cacheFlush: false, ttl: 120,
    data: { priority: 0, weight: 0, port: 8009, target: "afdd4ab8-51bc-954c-170d-37581867bf54.local" },
  });
  assert.deepEqual(a, {
    name: "afdd4ab8-51bc-954c-170d-37581867bf54.local", type: "A", rclass: 1, cacheFlush: false, ttl: 120, data: "10.0.0.10",
  });
});

test("decodes the Fuchsia multi-device reply: no question, cache-flush class, compressed names, AAAA", () => {
  const p = decodeDnsPacket(fixture("fuchsia-hub-max-groups"));
  assert.equal(p.questions.length, 0);
  assert.deepEqual(p.answers.map((r) => [r.type, r.data]), [
    ["PTR", "Google-Cast-Group-05f026bd12a77cf725b7b0b60b40087c._googlecast._tcp.local"],
    ["PTR", "Google-Nest-Hub-Max-de5a3c9b5b878aaa25520cecdc84a870._googlecast._tcp.local"],
    ["PTR", "Google-Cast-Group-b78130a884268cb55511b36410aeb7d5._googlecast._tcp.local"],
  ]);
  assert.equal(p.additionals.length, 11);
  const srvs = p.additionals.filter((r) => r.type === "SRV");
  assert.deepEqual(srvs.map((r) => r.type === "SRV" && [r.data.port, r.data.target, r.cacheFlush, r.rclass]), [
    [32044, "fuchsia-3769-c26f-b9bb.local", true, 1],
    [32200, "fuchsia-3769-c26f-b9bb.local", true, 1],
    [8009, "fuchsia-3769-c26f-b9bb.local", true, 1],
  ]);
  const txts = p.additionals.filter((r) => r.type === "TXT");
  assert.deepEqual(txts.map((r) => r.type === "TXT" && [r.data.id, r.data.fn, r.data.md]), [
    ["05f026bd-12a7-7cf7-25b7-b0b60b40087c", "Upstairs group", "Google Cast Group"],
    ["b78130a8-8426-8cb5-5511-b36410aeb7d5", "Everywhere", "Google Cast Group"],
    ["de5a3c9b5b878aaa25520cecdc84a870", "Hallway display", "Google Nest Hub Max"],
  ]);
  const addrs = p.additionals.filter((r) => r.type === "A" || r.type === "AAAA");
  assert.deepEqual(addrs.map((r) => [r.type, r.data, r.cacheFlush]), [
    ["A", "10.0.0.30", true],
    ["AAAA", "fd00::4", true],
    ["AAAA", "fd00::5", false],
    ["AAAA", "fd00::6", false],
    ["AAAA", "fd00::7", false],
  ]);
});

test("decodes all three fixtures without error", () => {
  for (const f of ["chromecast", "home-mini", "fuchsia-hub-max-groups"] as const) decodeDnsPacket(fixture(f));
});

test("encodes an mDNS PTR query", () => {
  const q = encodeMdnsQuery(SERVICE, RecordType.PTR);
  assert.ok(Buffer.isBuffer(q));
  const expected = Buffer.concat([header({ flags: 0, qd: 1 }), dnsName(SERVICE), Buffer.from([0, 12, 0, 1])]);
  assert.equal(q.toString("hex"), expected.toString("hex"));
  const qu = encodeMdnsQuery(SERVICE, RecordType.PTR, { unicastResponse: true });
  assert.equal(qu.subarray(-2).toString("hex"), "8001");
  assert.deepEqual(decodeDnsPacket(qu).questions, [{ name: SERVICE, type: 12, qclass: 1, unicastResponse: true }]);
  assert.equal(decodeDnsPacket(q).isResponse, false);
});

test("encodeMdnsQuery rejects bad names", () => {
  assert.throws(() => encodeMdnsQuery("a".repeat(64) + ".local", 12), RangeError);
  assert.throws(() => encodeMdnsQuery("a..local", 12), RangeError);
  assert.throws(() => encodeMdnsQuery(Array(130).fill("a").join("."), 12), RangeError);
});

test("follows compression pointers and returns names without a trailing dot", () => {
  const first = dnsName("dev._googlecast._tcp.local");
  const pkt = Buffer.concat([
    header({ an: 2 }),
    rr(first, 1, 1, 10, Buffer.from([10, 0, 0, 1])),
    // second record name: label "two" then pointer to offset 12 + 4 ("_googlecast..." inside first name)
    rr(Buffer.from([3, 0x74, 0x77, 0x6f, 0xc0, 12 + 4]), 1, 1, 10, Buffer.from([10, 0, 0, 2])),
  ]);
  const p = decodeDnsPacket(pkt);
  assert.equal(p.answers[0]?.name, "dev._googlecast._tcp.local");
  assert.equal(p.answers[1]?.name, "two._googlecast._tcp.local");
});

test("returns unknown record types with their raw bytes", () => {
  const pkt = Buffer.concat([header({ an: 1 }), rr("x.local", 47, 0x8001, 120, Buffer.from([1, 2, 3]))]);
  const [rec] = decodeDnsPacket(pkt).answers;
  assert.deepEqual(rec && { ...rec, data: Buffer.from(rec.data as Buffer).toString("hex") }, {
    name: "x.local", type: "UNKNOWN", typeCode: 47, rclass: 1, cacheFlush: true, ttl: 120, data: "010203",
  });
  assert.ok(rec && Buffer.isBuffer(rec.data));
});

test("parses TXT entries: lowercase keys, first wins, bare keys, '=' in values, empty strings skipped", () => {
  const pkt = Buffer.concat([
    header({ an: 1 }),
    rr("x.local", 16, 1, 120, txt(["FN=Kitchen", "fn=ignored", "flag", "", "url=a=b", "UTF=héllo"])),
  ]);
  const [rec] = decodeDnsPacket(pkt).answers;
  assert.equal(rec?.type, "TXT");
  assert.deepEqual({ ...(rec?.data as Record<string, string>) }, { fn: "Kitchen", flag: "", url: "a=b", utf: "héllo" });
});

test("TXT data is a plain object with no prototype keys", () => {
  const pkt = Buffer.concat([header({ an: 1 }), rr("x.local", 16, 1, 120, txt(["__proto__=x", "constructor=y"]))]);
  const [rec] = decodeDnsPacket(pkt).answers;
  assert.equal(Object.getPrototypeOf(rec?.data), null);
  assert.equal((rec?.data as Record<string, string>)["__proto__"], "x");
});

test("rejects pointer loops", () => {
  const pkt = Buffer.concat([header({ an: 1 }), Buffer.from([0xc0, 12]), Buffer.alloc(10)]);
  assert.throws(() => decodeDnsPacket(pkt), DnsFormatError);
});

test("rejects forward-pointing or out-of-range pointers", () => {
  const pkt = Buffer.concat([header({ an: 1 }), Buffer.from([0xc0, 0xff]), Buffer.alloc(10)]);
  assert.throws(() => decodeDnsPacket(pkt), DnsFormatError);
});

test("rejects reserved label types 0x40 and 0x80", () => {
  for (const lead of [0x40, 0x80]) {
    const pkt = Buffer.concat([header({ an: 1 }), Buffer.from([lead, 0x61, 0]), Buffer.alloc(10)]);
    assert.throws(() => decodeDnsPacket(pkt), DnsFormatError);
  }
});

test("rejects names longer than 255 bytes on the wire", () => {
  const long = Buffer.concat([...Array(5).fill(Buffer.concat([Buffer.from([60]), Buffer.alloc(60, 0x61)])), Buffer.from([0])]);
  const pkt = Buffer.concat([header({ an: 1 }), rr(long, 1, 1, 10, Buffer.from([1, 2, 3, 4]))]);
  assert.throws(() => decodeDnsPacket(pkt), DnsFormatError);
});

test("rejects truncated packets and short headers", () => {
  const full = fixture("chromecast");
  for (const len of [0, 5, 11, 20, 100, full.length - 1]) {
    assert.throws(() => decodeDnsPacket(full.subarray(0, len)), DnsFormatError, `len ${len}`);
  }
});

test("rejects RDATA whose length does not match the record type", () => {
  const badA = Buffer.concat([header({ an: 1 }), rr("x.local", 1, 1, 10, Buffer.from([1, 2, 3]))]);
  assert.throws(() => decodeDnsPacket(badA), DnsFormatError);
  const badAAAA = Buffer.concat([header({ an: 1 }), rr("x.local", 28, 1, 10, Buffer.alloc(15))]);
  assert.throws(() => decodeDnsPacket(badAAAA), DnsFormatError);
  const shortSrv = Buffer.concat([header({ an: 1 }), rr("x.local", 33, 1, 10, Buffer.from([0, 0, 0, 0, 0x1f]))]);
  assert.throws(() => decodeDnsPacket(shortSrv), DnsFormatError);
});

test("rejects a TXT entry that runs past its RDATA", () => {
  const pkt = Buffer.concat([header({ an: 1 }), rr("x.local", 16, 1, 10, Buffer.from([5, 0x61, 0x62]))]);
  assert.throws(() => decodeDnsPacket(pkt), DnsFormatError);
});

test("formatIPv6 follows RFC 5952", () => {
  const v6 = (hex: string) => formatIPv6(Buffer.from(hex.replaceAll(" ", ""), "hex"));
  assert.equal(v6("fe80 0000 0000 0000 0000 0000 0000 0001"), "fe80::1");
  assert.equal(v6("0000 0000 0000 0000 0000 0000 0000 0000"), "::");
  assert.equal(v6("0000 0000 0000 0000 0000 0000 0000 0001"), "::1");
  assert.equal(v6("2001 0db8 0000 0000 0001 0000 0000 0001"), "2001:db8::1:0:0:1");
  assert.equal(v6("2001 0db8 0000 0001 0001 0001 0001 0001"), "2001:db8:0:1:1:1:1:1");
  assert.equal(v6("2001 0db8 0000 0000 0001 0000 0000 0000"), "2001:db8:0:0:1::");
  assert.equal(v6("2001 0DB8 ABCD 0012 0000 0000 0000 0000"), "2001:db8:abcd:12::");
  assert.throws(() => formatIPv6(Buffer.alloc(4)), RangeError);
});

test("DnsFormatError is an Error with its own name", () => {
  const e = new DnsFormatError("x");
  assert.ok(e instanceof Error);
  assert.equal(e.name, "DnsFormatError");
});
