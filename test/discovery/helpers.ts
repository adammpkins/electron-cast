import { readFileSync } from "node:fs";

/** Sanitized real mDNS replies captured from a home network (see test/fixtures/mdns/README.md). */
export function fixture(name: "chromecast" | "home-mini" | "fuchsia-hub-max-groups"): Buffer {
  const url = new URL(`../fixtures/mdns/${name}.hex`, import.meta.url);
  return Buffer.from(readFileSync(url, "utf8").trim(), "hex");
}

export function dnsName(name: string): Buffer {
  const parts: Buffer[] = [];
  for (const label of name.split(".")) {
    const bytes = Buffer.from(label, "utf8");
    parts.push(Buffer.from([bytes.length]), bytes);
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

export function header(opts: { id?: number; flags?: number; qd?: number; an?: number; ns?: number; ar?: number }): Buffer {
  const b = Buffer.alloc(12);
  b.writeUInt16BE(opts.id ?? 0, 0);
  b.writeUInt16BE(opts.flags ?? 0x8400, 2);
  b.writeUInt16BE(opts.qd ?? 0, 4);
  b.writeUInt16BE(opts.an ?? 0, 6);
  b.writeUInt16BE(opts.ns ?? 0, 8);
  b.writeUInt16BE(opts.ar ?? 0, 10);
  return b;
}

export function rr(name: Buffer | string, type: number, cls: number, ttl: number, rdata: Buffer): Buffer {
  const fixed = Buffer.alloc(10);
  fixed.writeUInt16BE(type, 0);
  fixed.writeUInt16BE(cls, 2);
  fixed.writeUInt32BE(ttl, 4);
  fixed.writeUInt16BE(rdata.length, 8);
  return Buffer.concat([typeof name === "string" ? dnsName(name) : name, fixed, rdata]);
}

export function txt(entries: string[]): Buffer {
  return Buffer.concat(entries.map((e) => {
    const bytes = Buffer.from(e, "utf8");
    return Buffer.concat([Buffer.from([bytes.length]), bytes]);
  }));
}
