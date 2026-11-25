/**
 * A strict DER reader, in the spirit of BoringSSL's `bssl::der::Parser` (pki/parser.cc, pki/input.cc): definite
 * lengths only, minimal length encodings, single-byte tags.
 */

export class DerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DerError";
  }
}

export const Tag = {
  BOOLEAN: 0x01,
  INTEGER: 0x02,
  BIT_STRING: 0x03,
  OCTET_STRING: 0x04,
  NULL: 0x05,
  OID: 0x06,
  UTF8_STRING: 0x0c,
  SEQUENCE: 0x30,
  SET: 0x31,
  PRINTABLE_STRING: 0x13,
  T61_STRING: 0x14,
  IA5_STRING: 0x16,
  UTC_TIME: 0x17,
  GENERALIZED_TIME: 0x18,
  UNIVERSAL_STRING: 0x1c,
  BMP_STRING: 0x1e,
} as const;

/** Context-specific tag, `constructed` for the 0x20 bit. */
export function contextTag(number: number, constructed: boolean): number {
  return 0x80 | (constructed ? 0x20 : 0) | number;
}

/** One tag-length-value; `value` is the content, `raw` the whole encoding. */
export interface Tlv {
  tag: number;
  value: Buffer;
  raw: Buffer;
}

export class DerReader {
  private pos = 0;
  private readonly bytes: Buffer;

  constructor(bytes: Uint8Array) {
    this.bytes = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get hasMore(): boolean {
    return this.pos < this.bytes.length;
  }

  peekTag(): number | undefined {
    return this.bytes[this.pos];
  }

  /** Read any TLV. */
  read(): Tlv {
    const start = this.pos;
    const tag = this.bytes[this.pos++];
    if (tag === undefined) throw new DerError("unexpected end of input");
    if ((tag & 0x1f) === 0x1f) throw new DerError("high tag numbers are not supported");
    const first = this.bytes[this.pos++];
    if (first === undefined) throw new DerError("unexpected end of input");
    let length = first;
    if (first & 0x80) {
      const count = first & 0x7f;
      if (count === 0) throw new DerError("indefinite length is not DER");
      if (count > 4) throw new DerError("length too large");
      length = 0;
      for (let i = 0; i < count; i++) {
        const b = this.bytes[this.pos++];
        if (b === undefined) throw new DerError("unexpected end of input");
        if (i === 0 && b === 0) throw new DerError("length is not minimally encoded");
        length = length * 256 + b;
      }
      if (length < 0x80) throw new DerError("length is not minimally encoded");
    }
    const end = this.pos + length;
    if (end > this.bytes.length) throw new DerError("length runs past end of input");
    const value = this.bytes.subarray(this.pos, end);
    this.pos = end;
    return { tag, value, raw: this.bytes.subarray(start, end) };
  }

  /** Read a TLV that must have `tag`. */
  expect(tag: number): Tlv {
    const tlv = this.read();
    if (tlv.tag !== tag) throw new DerError(`expected tag 0x${tag.toString(16)}, got 0x${tlv.tag.toString(16)}`);
    return tlv;
  }

  /** Read a TLV only if the next tag matches. */
  optional(tag: number): Tlv | undefined {
    return this.peekTag() === tag ? this.read() : undefined;
  }

  /** Throws unless everything was consumed. */
  end(): void {
    if (this.hasMore) throw new DerError("trailing data");
  }
}

/** Read the children of a constructed TLV. */
export function children(tlv: Tlv): Tlv[] {
  const reader = new DerReader(tlv.value);
  const out: Tlv[] = [];
  while (reader.hasMore) out.push(reader.read());
  return out;
}

export function parseBoolean(tlv: Tlv): boolean {
  if (tlv.tag !== Tag.BOOLEAN || tlv.value.length !== 1) throw new DerError("bad BOOLEAN");
  const b = tlv.value[0];
  if (b === 0x00) return false;
  if (b === 0xff) return true;
  throw new DerError("BOOLEAN is not DER");
}

/** A non-negative INTEGER as bigint (DER minimal, no sign bit). */
export function parseUnsignedInteger(tlv: Tlv): bigint {
  if (tlv.tag !== Tag.INTEGER) throw new DerError("expected INTEGER");
  const v = tlv.value;
  if (v.length === 0) throw new DerError("empty INTEGER");
  if (v.length > 1 && ((v[0] === 0x00 && (v[1] as number) < 0x80) || (v[0] === 0xff && (v[1] as number) >= 0x80))) {
    throw new DerError("INTEGER is not minimally encoded");
  }
  if ((v[0] as number) & 0x80) throw new DerError("INTEGER is negative");
  return BigInt("0x" + v.toString("hex"));
}

/** Dotted form of an OBJECT IDENTIFIER's content bytes. */
export function oidString(content: Uint8Array): string {
  if (content.length === 0) throw new DerError("empty OID");
  const parts: bigint[] = [];
  let acc = 0n;
  for (const b of content) {
    acc = (acc << 7n) | BigInt(b & 0x7f);
    if ((b & 0x80) === 0) {
      parts.push(acc);
      acc = 0n;
    }
  }
  if ((content[content.length - 1] as number) & 0x80) throw new DerError("truncated OID");
  const first = parts[0] as bigint;
  const head = first < 40n ? [0n, first] : first < 80n ? [1n, first - 40n] : [2n, first - 80n];
  return [...head, ...parts.slice(1)].join(".");
}

/** Parse a UTCTime or GeneralizedTime in the RFC 5280 profile (UTC, seconds, trailing Z) to epoch milliseconds. */
export function parseTime(tlv: Tlv): number {
  const text = tlv.value.toString("latin1");
  let m: RegExpExecArray | null;
  let year: number;
  if (tlv.tag === Tag.UTC_TIME) {
    m = /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(text);
    if (m === null) throw new DerError("bad UTCTime");
    const yy = Number(m[1]);
    year = yy >= 50 ? 1900 + yy : 2000 + yy;
  } else if (tlv.tag === Tag.GENERALIZED_TIME) {
    m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(text);
    if (m === null) throw new DerError("bad GeneralizedTime");
    year = Number(m[1]);
  } else {
    throw new DerError("expected a time");
  }
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const dim = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (month < 1 || month > 12 || day < 1 || day > (dim as number) || hour > 23 || minute > 59 || second > 59) {
    throw new DerError("time out of range");
  }
  return Date.UTC(year, month - 1, day, hour, minute, second);
}

/** The content octets of a BIT STRING and its unused-bit count. */
export function parseBitString(tlv: Tlv): { bytes: Buffer; unusedBits: number } {
  if (tlv.tag !== Tag.BIT_STRING || tlv.value.length < 1) throw new DerError("bad BIT STRING");
  const unusedBits = tlv.value[0] as number;
  if (unusedBits > 7 || (tlv.value.length === 1 && unusedBits !== 0)) throw new DerError("bad BIT STRING padding");
  const bytes = tlv.value.subarray(1);
  if (unusedBits > 0 && ((bytes[bytes.length - 1] as number) & ((1 << unusedBits) - 1)) !== 0) {
    throw new DerError("BIT STRING padding bits are not zero");
  }
  return { bytes, unusedBits };
}
