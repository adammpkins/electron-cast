/** DNS/mDNS record type codes used by Cast discovery. */
export const RecordType = { A: 1, PTR: 12, TXT: 16, AAAA: 28, SRV: 33 } as const;

/** Thrown when a DNS packet is malformed or truncated. */
export class DnsFormatError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = "DnsFormatError";
  }
}

/** A question from the query section. */
export interface DnsQuestion {
  name: string;
  type: number;
  qclass: number;
  unicastResponse: boolean;
}

interface RecordBase {
  name: string;
  rclass: number;
  cacheFlush: boolean;
  ttl: number;
}

/** A decoded resource record; `type` discriminates the shape of `data`. */
export type DnsRecord =
  | (RecordBase & { type: "A"; data: string })
  | (RecordBase & { type: "AAAA"; data: string })
  | (RecordBase & { type: "PTR"; data: string })
  | (RecordBase & { type: "TXT"; data: Record<string, string> })
  | (RecordBase & { type: "SRV"; data: { priority: number; weight: number; port: number; target: string } })
  | (RecordBase & { type: "UNKNOWN"; typeCode: number; data: Buffer });

/** A fully decoded DNS packet. */
export interface DnsPacket {
  id: number;
  flags: number;
  isResponse: boolean;
  questions: DnsQuestion[];
  answers: DnsRecord[];
  authorities: DnsRecord[];
  additionals: DnsRecord[];
}

function u16(buf: Uint8Array, off: number): number {
  if (off + 2 > buf.length) throw new DnsFormatError("read past end of packet");
  return (buf[off]! << 8) | buf[off + 1]!;
}

function u32(buf: Uint8Array, off: number): number {
  if (off + 4 > buf.length) throw new DnsFormatError("read past end of packet");
  return ((buf[off]! * 0x100 + buf[off + 1]!) * 0x100 + buf[off + 2]!) * 0x100 + buf[off + 3]!;
}

function utf8(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("utf8");
}

/**
 * Reads a (possibly compressed) domain name starting at `start`. Inline bytes
 * must stay before `limit`; a pointer may jump to any earlier offset in the
 * packet. Returns the joined name and the stream position just past the inline
 * encoding (the final zero, or the 2-byte pointer).
 */
function readName(buf: Uint8Array, start: number, limit: number): { name: string; next: number } {
  const labels: string[] = [];
  let pos = start;
  let lim = limit;
  let next = -1;
  let wire = 0;
  for (;;) {
    if (pos >= lim) throw new DnsFormatError("name read past end of section");
    const lead = buf[pos]!;
    const tag = lead & 0xc0;
    if (tag === 0xc0) {
      if (pos + 1 >= lim) throw new DnsFormatError("truncated compression pointer");
      const target = ((lead & 0x3f) << 8) | buf[pos + 1]!;
      if (target >= pos) throw new DnsFormatError("compression pointer does not point backwards");
      if (next === -1) next = pos + 2;
      pos = target;
      lim = buf.length;
      continue;
    }
    if (tag === 0x40 || tag === 0x80) throw new DnsFormatError("reserved label type");
    if (lead === 0) {
      wire += 1;
      if (wire > 255) throw new DnsFormatError("name exceeds 255 bytes on the wire");
      if (next === -1) next = pos + 1;
      break;
    }
    const len = lead;
    if (pos + 1 + len > lim) throw new DnsFormatError("label read past end of section");
    wire += 1 + len;
    if (wire > 255) throw new DnsFormatError("name exceeds 255 bytes on the wire");
    labels.push(utf8(buf.subarray(pos + 1, pos + 1 + len)));
    pos += 1 + len;
  }
  return { name: labels.join("."), next };
}

/** Parses TXT RDATA: length-prefixed strings that must fit exactly in [start, end). */
function parseTxt(buf: Uint8Array, start: number, end: number): Record<string, string> {
  const data: Record<string, string> = Object.create(null);
  let pos = start;
  while (pos < end) {
    const len = buf[pos]!;
    pos += 1;
    if (pos + len > end) throw new DnsFormatError("TXT entry runs past RDATA");
    const entry = utf8(buf.subarray(pos, pos + len));
    pos += len;
    if (entry === "") continue;
    // CreateCastMediaSink (chrome/browser/media/router/discovery/mdns/media_sink_util.cc): an entry without `=` is
    // skipped, keys are case-sensitive, and the last entry for a key wins (`service_data[key] = val`)
    const eq = entry.indexOf("=");
    if (eq === -1) continue;
    data[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return data;
}

/** Reads one resource record at `start`; the record always ends at rdataStart + RDLENGTH. */
function readRecord(buf: Uint8Array, start: number): { record: DnsRecord; next: number } {
  const { name, next: afterName } = readName(buf, start, buf.length);
  const type = u16(buf, afterName);
  const cls = u16(buf, afterName + 2);
  const ttl = u32(buf, afterName + 4);
  const rdlen = u16(buf, afterName + 8);
  const rdataStart = afterName + 10;
  const rdataEnd = rdataStart + rdlen;
  if (rdataEnd > buf.length) throw new DnsFormatError("RDATA runs past end of packet");
  const base = { name, rclass: cls & 0x7fff, cacheFlush: (cls & 0x8000) !== 0, ttl };
  let record: DnsRecord;
  switch (type) {
    case RecordType.A: {
      if (rdlen !== 4) throw new DnsFormatError("A record RDATA must be exactly 4 bytes");
      record = {
        ...base,
        type: "A",
        data: `${buf[rdataStart]}.${buf[rdataStart + 1]}.${buf[rdataStart + 2]}.${buf[rdataStart + 3]}`,
      };
      break;
    }
    case RecordType.AAAA: {
      if (rdlen !== 16) throw new DnsFormatError("AAAA record RDATA must be exactly 16 bytes");
      record = { ...base, type: "AAAA", data: formatIPv6(buf.subarray(rdataStart, rdataEnd)) };
      break;
    }
    case RecordType.PTR: {
      record = { ...base, type: "PTR", data: readName(buf, rdataStart, rdataEnd).name };
      break;
    }
    case RecordType.SRV: {
      if (rdlen < 7) throw new DnsFormatError("SRV record RDATA must be at least 7 bytes");
      const target = readName(buf, rdataStart + 6, rdataEnd).name;
      record = {
        ...base,
        type: "SRV",
        data: { priority: u16(buf, rdataStart), weight: u16(buf, rdataStart + 2), port: u16(buf, rdataStart + 4), target },
      };
      break;
    }
    case RecordType.TXT: {
      record = { ...base, type: "TXT", data: parseTxt(buf, rdataStart, rdataEnd) };
      break;
    }
    default: {
      record = { ...base, type: "UNKNOWN", typeCode: type, data: Buffer.from(buf.subarray(rdataStart, rdataEnd)) };
      break;
    }
  }
  return { record, next: rdataEnd };
}

function readRecords(buf: Uint8Array, count: number, start: number): { records: DnsRecord[]; next: number } {
  const records: DnsRecord[] = [];
  let pos = start;
  for (let i = 0; i < count; i++) {
    const r = readRecord(buf, pos);
    records.push(r.record);
    pos = r.next;
  }
  return { records, next: pos };
}

/** Decodes a DNS/mDNS packet, throwing {@link DnsFormatError} on any malformation. */
export function decodeDnsPacket(buf: Uint8Array): DnsPacket {
  if (buf.length < 12) throw new DnsFormatError("packet shorter than the 12-byte header");
  const id = u16(buf, 0);
  const flags = u16(buf, 2);
  const qdcount = u16(buf, 4);
  const ancount = u16(buf, 6);
  const nscount = u16(buf, 8);
  const arcount = u16(buf, 10);
  let pos = 12;
  const questions: DnsQuestion[] = [];
  for (let i = 0; i < qdcount; i++) {
    const { name, next } = readName(buf, pos, buf.length);
    const type = u16(buf, next);
    const cls = u16(buf, next + 2);
    questions.push({ name, type, qclass: cls & 0x7fff, unicastResponse: (cls & 0x8000) !== 0 });
    pos = next + 4;
  }
  const answers = readRecords(buf, ancount, pos);
  const authorities = readRecords(buf, nscount, answers.next);
  const additionals = readRecords(buf, arcount, authorities.next);
  return {
    id,
    flags,
    isResponse: (flags & 0x8000) !== 0,
    questions,
    answers: answers.records,
    authorities: authorities.records,
    additionals: additionals.records,
  };
}

/** Encodes a single-question mDNS query (no compression, class IN). */
export function encodeMdnsQuery(name: string, type: number, opts?: { unicastResponse?: boolean }): Buffer {
  const parts: number[] = [];
  for (const label of name.split(".")) {
    const bytes = Buffer.from(label, "utf8");
    if (bytes.length === 0) throw new RangeError("name contains an empty label");
    if (bytes.length > 63) throw new RangeError("name label exceeds 63 bytes");
    parts.push(bytes.length);
    for (const b of bytes) parts.push(b);
  }
  parts.push(0);
  if (parts.length > 255) throw new RangeError("name exceeds 255 bytes on the wire");
  const out = Buffer.alloc(12 + parts.length + 4);
  out.writeUInt16BE(1, 4);
  out.set(parts, 12);
  out.writeUInt16BE(type, 12 + parts.length);
  out.writeUInt16BE(opts?.unicastResponse ? 0x8001 : 1, 14 + parts.length);
  return out;
}

/** Formats 16 bytes as an IPv6 address per RFC 5952. */
export function formatIPv6(bytes: Uint8Array): string {
  if (bytes.length !== 16) throw new RangeError("IPv6 address must be exactly 16 bytes");
  const groups: number[] = [];
  for (let i = 0; i < 8; i++) groups.push((bytes[i * 2]! << 8) | bytes[i * 2 + 1]!);
  let bestStart = -1;
  let bestLen = 0;
  for (let i = 0; i < 8; ) {
    if (groups[i]! !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j]! === 0) j++;
    if (j - i > bestLen) {
      bestLen = j - i;
      bestStart = i;
    }
    i = j;
  }
  const hex = (g: number) => g.toString(16);
  if (bestLen < 2) return groups.map(hex).join(":");
  const left = groups.slice(0, bestStart).map(hex).join(":");
  const right = groups.slice(bestStart + bestLen).map(hex).join(":");
  return `${left}::${right}`;
}
