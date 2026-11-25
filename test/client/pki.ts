import { createSign, generateKeyPairSync, type KeyObject } from "node:crypto";

/**
 * A small X.509 / Cast CRL factory for tests, built on Node crypto and hand-written DER. Every key is generated on the
 * fly: the tests never carry a private key belonging to a real device or CA.
 */

export const der = {
  tlv(tag: number, content: Uint8Array): Buffer {
    const n = content.length;
    let header: number[];
    if (n < 0x80) header = [tag, n];
    else if (n < 0x100) header = [tag, 0x81, n];
    else if (n < 0x10000) header = [tag, 0x82, n >> 8, n & 0xff];
    else header = [tag, 0x83, n >> 16, (n >> 8) & 0xff, n & 0xff];
    return Buffer.concat([Buffer.from(header), content]);
  },
  seq: (...items: Uint8Array[]) => der.tlv(0x30, Buffer.concat(items)),
  set: (...items: Uint8Array[]) => der.tlv(0x31, Buffer.concat(items)),
  oid(dotted: string): Buffer {
    const parts = dotted.split(".").map(Number);
    const bytes: number[] = [(parts[0] as number) * 40 + (parts[1] as number)];
    for (const part of parts.slice(2)) {
      const chunk = [part & 0x7f];
      let rest = part >>> 7;
      while (rest > 0) {
        chunk.unshift((rest & 0x7f) | 0x80);
        rest >>>= 7;
      }
      bytes.push(...chunk);
    }
    return der.tlv(0x06, Buffer.from(bytes));
  },
  int(value: number | bigint): Buffer {
    let hex = BigInt(value).toString(16);
    if (hex.length % 2) hex = "0" + hex;
    let bytes = Buffer.from(hex, "hex");
    if ((bytes[0] as number) & 0x80) bytes = Buffer.concat([Buffer.from([0]), bytes]);
    return der.tlv(0x02, bytes);
  },
  bool: (v: boolean) => der.tlv(0x01, Buffer.from([v ? 0xff : 0])),
  utf8: (s: string) => der.tlv(0x0c, Buffer.from(s)),
  octets: (b: Uint8Array) => der.tlv(0x04, b),
  bits(b: Uint8Array, unused = 0): Buffer {
    return der.tlv(0x03, Buffer.concat([Buffer.from([unused]), b]));
  },
  null: () => der.tlv(0x05, Buffer.alloc(0)),
  ctx: (n: number, content: Uint8Array) => der.tlv(0xa0 | n, content),
  time(ms: number): Buffer {
    const d = new Date(ms);
    const p = (n: number, w = 2) => String(n).padStart(w, "0");
    const y = d.getUTCFullYear();
    const rest = `${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
    if (y >= 1950 && y < 2050) return der.tlv(0x17, Buffer.from(`${p(y % 100)}${rest}`));
    return der.tlv(0x18, Buffer.from(`${p(y, 4)}${rest}`));
  },
};

const RSA_SHA256 = der.seq(der.oid("1.2.840.113549.1.1.11"), der.null());

export interface KeyPair {
  publicKey: KeyObject;
  privateKey: KeyObject;
}

export function newKey(): KeyPair {
  return generateKeyPairSync("rsa", { modulusLength: 2048 });
}

export const spkiOf = (key: KeyObject): Buffer => key.export({ type: "spki", format: "der" });

function name(cn: string): Buffer {
  return der.seq(der.set(der.seq(der.oid("2.5.4.3"), der.utf8(cn))));
}

function extension(oid: string, value: Uint8Array, critical = false): Buffer {
  return der.seq(der.oid(oid), ...(critical ? [der.bool(true)] : []), der.octets(value));
}

export const EXT = {
  basicConstraints(ca: boolean, pathLen?: number): Buffer {
    return extension("2.5.29.19", der.seq(...(ca ? [der.bool(true)] : []), ...(pathLen === undefined ? [] : [der.int(pathLen)])), true);
  },
  /** `bits` are the asserted bit numbers, e.g. 0 for digitalSignature and 5 for keyCertSign. */
  keyUsage(...bits: number[]): Buffer {
    let value = 0;
    for (const b of bits) value |= 0x80 >> b;
    const highest = Math.max(...bits);
    return extension("2.5.29.15", der.bits(Buffer.from([value]), 7 - highest), true);
  },
  eku(...oids: string[]): Buffer {
    return extension("2.5.29.37", der.seq(...oids.map((o) => der.oid(o))));
  },
  policies(...oids: string[]): Buffer {
    return extension("2.5.29.32", der.seq(...oids.map((o) => der.seq(der.oid(o)))));
  },
  /** nameConstraints permitting only the given DNS subtrees. */
  permitDns(...dns: string[]): Buffer {
    const subtrees = dns.map((d) => der.seq(der.tlv(0x82, Buffer.from(d))));
    return extension("2.5.29.30", der.seq(der.ctx(0, Buffer.concat(subtrees))), true);
  },
  san(...dns: string[]): Buffer {
    return extension("2.5.29.17", der.seq(...dns.map((d) => der.tlv(0x82, Buffer.from(d)))));
  },
  unknownCritical: () => extension("1.2.3.4.5.6", der.null(), true),
};

export const OID_CLIENT_AUTH = "1.3.6.1.5.5.7.3.2";
export const OID_SERVER_AUTH = "1.3.6.1.5.5.7.3.1";
export const OID_AUDIO_ONLY = "1.3.6.1.4.1.11129.2.5.2";

export interface CertSpec {
  subject: string;
  issuer?: string;
  key: KeyPair;
  /** Signs the certificate; defaults to `key` (self-signed). */
  signer?: KeyPair;
  serial?: number | bigint;
  notBefore: number;
  notAfter: number;
  extensions?: Buffer[];
}

export function makeCert(spec: CertSpec): Buffer {
  const signer = spec.signer ?? spec.key;
  const tbs = der.seq(
    der.ctx(0, der.int(2)),
    der.int(spec.serial ?? 1),
    RSA_SHA256,
    name(spec.issuer ?? spec.subject),
    der.seq(der.time(spec.notBefore), der.time(spec.notAfter)),
    name(spec.subject),
    spkiOf(spec.key.publicKey),
    ...(spec.extensions === undefined || spec.extensions.length === 0 ? [] : [der.ctx(3, der.seq(...spec.extensions))]),
  );
  const signature = createSign("sha256").update(tbs).sign(signer.privateKey);
  return der.seq(tbs, RSA_SHA256, der.bits(signature));
}

export const toPem = (derBytes: Uint8Array, label = "CERTIFICATE"): string =>
  `-----BEGIN ${label}-----\n${Buffer.from(derBytes).toString("base64").replace(/(.{64})/g, "$1\n")}\n-----END ${label}-----\n`;

// --- Cast CRLs (revocation.proto) ---------------------------------------------------------------------------------

function varint(n: number | bigint): Buffer {
  let v = BigInt(n);
  const out: number[] = [];
  while (v >= 0x80n) {
    out.push(Number(v & 0x7fn) | 0x80);
    v >>= 7n;
  }
  out.push(Number(v));
  return Buffer.from(out);
}
const pbBytes = (field: number, b: Uint8Array) => Buffer.concat([varint(field << 3 | 2), varint(b.length), b]);
const pbInt = (field: number, n: number | bigint) => Buffer.concat([varint(field << 3), varint(n)]);

export interface CrlSpec {
  signerCert: Buffer;
  signerKey: KeyPair;
  notBeforeSeconds: number;
  notAfterSeconds: number;
  revokedPublicKeyHashes?: Buffer[];
  serialRanges?: { issuerPublicKeyHash: Buffer; first: number; last: number }[];
  version?: number;
}

export function makeCrlBundle(spec: CrlSpec): Buffer {
  const tbs = Buffer.concat([
    pbInt(1, spec.version ?? 0),
    pbInt(2, spec.notBeforeSeconds),
    pbInt(3, spec.notAfterSeconds),
    ...(spec.revokedPublicKeyHashes ?? []).map((h) => pbBytes(4, h)),
    ...(spec.serialRanges ?? []).map((r) =>
      pbBytes(5, Buffer.concat([pbBytes(1, r.issuerPublicKeyHash), pbInt(2, r.first), pbInt(3, r.last)])),
    ),
  ]);
  const signature = createSign("sha256").update(tbs).sign(spec.signerKey.privateKey);
  const crl = Buffer.concat([pbBytes(1, tbs), pbBytes(2, spec.signerCert), pbBytes(3, signature)]);
  return pbBytes(1, crl);
}
