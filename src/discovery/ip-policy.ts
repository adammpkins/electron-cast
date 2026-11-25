// Which device addresses a Cast channel may be opened to. A port of the check in Chromium's
// CastMediaSinkServiceImpl::OpenChannel (chrome/browser/media/router/discovery/mdns/cast_media_sink_service_impl.cc):
// a sink whose address is publicly routable or loopback is not connected to unless the MediaRouterCastAllowAllIPs
// policy allows every address. The two predicates are net::IPAddress::IsPubliclyRoutable and IsLoopback
// (net/base/ip_address.cc), reproduced here including their quirks.
import { isIPv4, isIPv6 } from "node:net";

/** Parses an IPv4 or IPv6 literal (an IPv6 zone such as `%12` is ignored) into its bytes, or null when it is neither. */
export function parseIpBytes(address: string): Uint8Array | null {
  if (typeof address !== "string") return null;
  const bare = address.startsWith("[") && address.endsWith("]") ? address.slice(1, -1) : address;
  if (isIPv4(bare)) return Uint8Array.from(bare.split(".").map(Number));
  const zone = bare.indexOf("%");
  const text = zone === -1 ? bare : bare.slice(0, zone);
  if (!isIPv6(text)) return null;
  return ipv6Bytes(text);
}

function ipv6Bytes(text: string): Uint8Array {
  let s = text;
  if (s.includes(".")) {
    // An embedded IPv4 tail (`::ffff:1.2.3.4`) is the last two groups.
    const colon = s.lastIndexOf(":");
    const v4 = s.slice(colon + 1).split(".").map(Number);
    s = `${s.slice(0, colon + 1)}${(((v4[0] ?? 0) << 8) | (v4[1] ?? 0)).toString(16)}:${(((v4[2] ?? 0) << 8) | (v4[3] ?? 0)).toString(16)}`;
  }
  const halves = s.split("::");
  const head = (halves[0] ?? "") === "" ? [] : (halves[0] ?? "").split(":");
  const tail = halves.length < 2 || (halves[1] ?? "") === "" ? [] : (halves[1] ?? "").split(":");
  const groups = halves.length < 2 ? head : [...head, ...Array.from({ length: 8 - head.length - tail.length }, () => "0"), ...tail];
  const out = new Uint8Array(16);
  groups.forEach((g, i) => {
    const n = parseInt(g, 16);
    out[i * 2] = n >> 8;
    out[i * 2 + 1] = n & 0xff;
  });
  return out;
}

/** net's IPAddressPrefixCheck: do the first `bits` bits of `bytes` equal those of `prefix`? */
function hasPrefix(bytes: Uint8Array, prefix: readonly number[], bits: number): boolean {
  const whole = bits >> 3;
  for (let i = 0; i < whole; i++) if (bytes[i] !== prefix[i]) return false;
  const rest = bits & 7;
  if (rest === 0) return true;
  const mask = (0xff << (8 - rest)) & 0xff;
  return ((bytes[whole] ?? 0) & mask) === ((prefix[whole] ?? 0) & mask);
}

/** net's kReservedIPv4Ranges: IANA special-purpose and local ranges (net/base/ip_address.cc). */
const RESERVED_IPV4: ReadonlyArray<readonly [readonly number[], number]> = [
  [[0, 0, 0, 0], 8], [[10, 0, 0, 0], 8], [[100, 64, 0, 0], 10], [[127, 0, 0, 0], 8], [[169, 254, 0, 0], 16],
  [[172, 16, 0, 0], 12], [[192, 0, 0, 0], 24], [[192, 0, 2, 0], 24], [[192, 88, 99, 0], 24], [[192, 168, 0, 0], 16],
  [[198, 18, 0, 0], 15], [[198, 51, 100, 0], 24], [[203, 0, 113, 0], 24], [[224, 0, 0, 0], 3],
];

const V4_MAPPED_PREFIX = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff];

function ipv4PubliclyRoutable(bytes: Uint8Array): boolean {
  return !RESERVED_IPV4.some(([prefix, bits]) => hasPrefix(bytes, prefix, bits));
}

/**
 * `net::IPAddress::IsPubliclyRoutable`. IPv4 is publicly routable unless it is in a reserved range (so 100.64.0.0/10,
 * carrier-grade NAT, is not). IPv6 is publicly routable only inside 2000::/3 (global unicast) and ff00::/8
 * (multicast); unique-local fc00::/7, link-local fe80::/10, `::` and `::1` are not. An IPv4-mapped IPv6 address is
 * judged by its IPv4 part. Anything that is not an IP address counts as publicly routable, as an empty `IPAddress` does
 * in Chromium, so an unparseable address is refused.
 */
export function isPubliclyRoutable(address: string): boolean {
  const bytes = parseIpBytes(address);
  if (bytes === null) return true;
  if (bytes.length === 4) return ipv4PubliclyRoutable(bytes);
  if (hasPrefix(bytes, [0x20, 0], 3) || hasPrefix(bytes, [0xff, 0], 8)) return true;
  if (hasPrefix(bytes, V4_MAPPED_PREFIX, 96)) return ipv4PubliclyRoutable(bytes.subarray(12));
  return false;
}

/**
 * `net::IPAddress::IsLoopback`: 127.0.0.0/8 or exactly `::1`. `::ffff:127.0.0.1` is not loopback by this predicate
 * (and, being reserved IPv4, not publicly routable either), so Chrome opens a channel to it.
 */
export function isLoopback(address: string): boolean {
  const bytes = parseIpBytes(address);
  if (bytes === null) return false;
  if (bytes.length === 4) return bytes[0] === 127;
  for (let i = 0; i < 15; i++) if (bytes[i] !== 0) return false;
  return bytes[15] === 1;
}

/**
 * Whether a channel may be opened to `address`: not publicly routable and not loopback, unless `allowAllIPs` (the
 * `MediaRouterCastAllowAllIPs` policy) is set.
 */
export function isCastAddressAllowed(address: string, allowAllIPs = false): boolean {
  return allowAllIPs || !(isPubliclyRoutable(address) || isLoopback(address));
}
