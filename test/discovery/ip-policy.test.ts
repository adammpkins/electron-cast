import { test } from "node:test";
import assert from "node:assert/strict";
import { isCastAddressAllowed, isLoopback, isPubliclyRoutable, parseIpBytes } from "../../src/discovery/ip-policy.ts";

// Expectations come from reading net/base/ip_address.cc (IsPubliclyRoutable, IsLoopback) and
// CastMediaSinkServiceImpl::OpenChannel; "allowed" means Chrome opens a channel without MediaRouterCastAllowAllIPs.
const CASES: Array<[address: string, allowed: boolean, why: string]> = [
  // IPv4 public
  ["8.8.8.8", false, "public"],
  ["172.15.255.255", false, "just below 172.16/12"],
  ["172.32.0.0", false, "just above 172.16/12"],
  ["192.0.1.1", false, "outside 192.0.0.0/24 and 192.0.2.0/24"],
  ["198.20.0.0", false, "just above 198.18/15"],
  ["100.63.255.255", false, "just below 100.64/10"],
  ["100.128.0.0", false, "just above 100.64/10"],
  ["223.255.255.255", false, "just below 224/3"],
  // IPv4 reserved (not publicly routable): allowed
  ["10.0.0.1", true, "10/8"],
  ["172.16.0.1", true, "172.16/12"],
  ["172.31.255.255", true, "172.16/12 top"],
  ["192.168.1.20", true, "192.168/16"],
  ["169.254.10.10", true, "link-local"],
  ["100.64.0.1", true, "CGNAT 100.64/10"],
  ["100.127.255.255", true, "CGNAT top"],
  ["0.0.0.0", true, "0/8 is reserved and not loopback"],
  ["192.0.0.9", true, "192.0.0.0/24"],
  ["192.0.2.7", true, "TEST-NET-1"],
  ["192.88.99.1", true, "6to4 relay anycast"],
  ["198.18.0.1", true, "benchmarking 198.18/15"],
  ["198.19.255.255", true, "benchmarking top"],
  ["198.51.100.1", true, "TEST-NET-2"],
  ["203.0.113.1", true, "TEST-NET-3"],
  ["224.0.0.251", true, "multicast, in 224/3"],
  ["255.255.255.255", true, "broadcast, in 224/3"],
  // IPv4 loopback
  ["127.0.0.1", false, "loopback"],
  ["127.255.255.255", false, "loopback /8"],
  // IPv6 public: 2000::/3 and ff00::/8
  ["2001:db8::1", false, "in 2000::/3 (the documentation range is not special-cased)"],
  ["2606:4700:4700::1111", false, "global unicast"],
  ["3fff::1", false, "top of 2000::/3"],
  ["ff02::fb", false, "multicast counts as public"],
  // IPv6 not public
  ["fe80::1", true, "link-local fe80::/10"],
  ["fe80::1%12", true, "link-local with a zone"],
  ["febf::1", true, "top of fe80::/10, still not 2000::/3"],
  ["fc00::1", true, "unique local fc00::/7"],
  ["fd12:3456:789a::5", true, "unique local"],
  ["::", true, "unspecified is not loopback and not public"],
  ["4000::1", true, "outside 2000::/3"],
  ["1fff::1", true, "just below 2000::/3"],
  // IPv6 loopback
  ["::1", false, "loopback"],
  // IPv4-mapped: judged by the IPv4 part for publicness, but only ::1 is IPv6 loopback
  ["::ffff:192.168.1.1", true, "mapped private"],
  ["::ffff:c0a8:101", true, "mapped private, hex form"],
  ["::ffff:100.64.0.1", true, "mapped CGNAT"],
  ["::ffff:8.8.8.8", false, "mapped public"],
  ["::ffff:127.0.0.1", true, "mapped loopback: IsLoopback is false and reserved IPv4 is not public (a Chromium quirk)"],
  // Not an address: an empty net::IPAddress counts as publicly routable
  ["", false, "empty"],
  ["not-an-ip", false, "hostname"],
  ["1.2.3", false, "short IPv4"],
];

for (const [address, allowed, why] of CASES) {
  test(`isCastAddressAllowed(${JSON.stringify(address)}) is ${allowed} (${why})`, () => {
    assert.equal(isCastAddressAllowed(address), allowed);
  });
}

test("allowAllIps allows every address, including unparseable ones", () => {
  for (const [address] of CASES) assert.equal(isCastAddressAllowed(address, true), true, address);
});

test("the two predicates agree with Chromium's separately", () => {
  assert.equal(isPubliclyRoutable("100.64.0.1"), false);
  assert.equal(isPubliclyRoutable("127.0.0.1"), false); // reserved, so refused only through isLoopback
  assert.equal(isLoopback("127.0.0.1"), true);
  assert.equal(isLoopback("::1"), true);
  assert.equal(isLoopback("::2"), false);
  assert.equal(isLoopback("::ffff:127.0.0.1"), false);
  assert.equal(isPubliclyRoutable("2001:db8::1"), true);
  assert.equal(isPubliclyRoutable("fc00::1"), false);
});

test("parseIpBytes expands IPv6 forms", () => {
  assert.deepEqual([...(parseIpBytes("::1") ?? [])], [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
  assert.deepEqual([...(parseIpBytes("fe80::1%eth0") ?? [])].slice(0, 2), [0xfe, 0x80]);
  assert.deepEqual([...(parseIpBytes("::ffff:1.2.3.4") ?? [])].slice(10), [0xff, 0xff, 1, 2, 3, 4]);
  assert.deepEqual([...(parseIpBytes("1:2:3:4:5:6:7:8") ?? [])], [0, 1, 0, 2, 0, 3, 0, 4, 0, 5, 0, 6, 0, 7, 0, 8]);
  assert.equal(parseIpBytes("1.2.3.4.5"), null);
});
