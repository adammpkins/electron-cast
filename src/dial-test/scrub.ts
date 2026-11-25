// Removes what identifies a person or a home network from the text of a DIAL test report: the device's names and
// serial numbers, its UUIDs, MAC addresses, IP addresses and the host of every URL. Everything the report says goes
// through {@link Scrubber.scrub} once, at the end, so a field added later cannot skip it.

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
/** A UUID without dashes, as the library writes a sink id. */
const BARE_UUID = /\b[0-9a-f]{32}\b/gi;
const MAC = /\b[0-9a-f]{2}(?:[:-][0-9a-f]{2}){5}\b/gi;
const IPV4 = /\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/g;
const IPV6 = /\b(?:[0-9a-f]{1,4}:){2,7}[0-9a-f]{0,4}\b|\bfe80::[0-9a-f:]*/gi;
const URL_HOST = /\b(https?:\/\/)(?:[^\s/@<>"']*@)?(\[[0-9a-f:.]+\]|[^\s/:?#<>"'[]+)/gi;

export class Scrubber {
  private readonly ips = new Map<string, string>();
  /** The addresses handed out, so that scrubbing scrubbed text leaves them alone. */
  private readonly mapped = new Set<string>();
  private readonly literals = new Map<string, string>();

  /** Registers a value (a friendly name, a serial number, a UDN) that is replaced wherever it appears, in any letter case. */
  secret(value: string | null | undefined, replacement: string): void {
    if (value === null || value === undefined) return;
    const trimmed = value.trim();
    if (trimmed.length < 3) return;
    if (!this.literals.has(trimmed.toLowerCase())) this.literals.set(trimmed.toLowerCase(), replacement);
  }

  /** The documentation address (192.0.2.N, RFC 5737) standing for `address` in this report. */
  ip(address: string): string {
    let mapped = this.ips.get(address);
    if (mapped === undefined) {
      mapped = `192.0.2.${this.ips.size + 1}`;
      this.ips.set(address, mapped);
      this.mapped.add(mapped);
    }
    return mapped;
  }

  /** Registers a UDN or UUID in the forms a device writes it. */
  uuid(value: string | null | undefined): void {
    if (value === null || value === undefined || value === "") return;
    const bare = value.replace(/^uuid:/i, "");
    this.secret(value, "<udn>");
    this.secret(bare, "<udn>");
    this.secret(bare.replaceAll("-", ""), "<udn>");
  }

  scrub(text: string): string {
    let out = text;
    // Longest first, so a name that contains another registered value is replaced as a whole.
    const known = [...this.literals.entries()].sort((a, b) => b[0].length - a[0].length);
    for (const [value, replacement] of known) out = out.replace(new RegExp(escapeRe(value), "gi"), replacement);
    out = out.replace(URL_HOST, (_whole, scheme: string, host: string) => `${scheme}${this.hostName(host)}`);
    out = out.replace(UUID, "<uuid>").replace(MAC, "<mac>").replace(BARE_UUID, "<uuid>");
    out = out.replace(IPV6, "<ipv6>");
    // Text that was scrubbed already keeps its documentation addresses.
    out = out.replace(IPV4, (ip) => (this.ips.has(ip) || !this.mapped.has(ip) ? this.ip(ip) : ip));
    return out;
  }

  private hostName(host: string): string {
    if (host.startsWith("[")) return "[<ipv6>]";
    // An address is mapped by the IPv4 pass that follows, once, so that a mapped address is never mapped again.
    return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) ? host : "host.invalid";
  }
}
