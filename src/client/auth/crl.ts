import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";
import { forEachField } from "../../protocol/proto-wire.ts";
import { buildAndVerifyPath } from "./path-validator.ts";
import { CertParseError, parseCertificate, type ParsedCertificate } from "./x509.ts";
import { DerError } from "./der.ts";

/**
 * Cast certificate revocation lists, ported from components/media_router/common/providers/cast/certificate/
 * cast_crl.cc (ParseAndVerifyCRLUsingCustomTrustStore, VerifyCRL, CastCRLImpl) and the revocation.proto messages
 * (CrlBundle, Crl, TbsCrl, SerialNumberRange) it reads.
 */

/** Chromium's kFallbackCrlValidityInSeconds: the built-in fallback CRL is valid for 20 weeks from its "build time". */
const FALLBACK_CRL_VALIDITY_MS = 20 * 7 * 24 * 60 * 60 * 1000;

interface SerialRange {
  first: bigint;
  last: bigint;
}

interface TbsCrl {
  version: bigint;
  notBeforeSeconds: bigint;
  notAfterSeconds: bigint;
  revokedPublicKeyHashes: Buffer[];
  ranges: { issuerPublicKeyHash: Buffer; first: bigint; last: bigint }[];
}

interface CrlMessage {
  tbsCrl: Buffer | undefined;
  signerCert: Buffer | undefined;
  signature: Buffer | undefined;
}

function parseCrlBundle(bytes: Uint8Array): CrlMessage[] {
  const crls: CrlMessage[] = [];
  forEachField(bytes, (number, wireType, value) => {
    if (number !== 1 || wireType !== 2) return;
    const crl: CrlMessage = { tbsCrl: undefined, signerCert: undefined, signature: undefined };
    forEachField(value as Uint8Array, (n, w, v) => {
      if (w !== 2) return;
      const data = Buffer.from(v as Uint8Array);
      if (n === 1) crl.tbsCrl = data;
      else if (n === 2) crl.signerCert = data;
      else if (n === 3) crl.signature = data;
    });
    crls.push(crl);
  });
  return crls;
}

function parseTbsCrl(bytes: Uint8Array): TbsCrl {
  const tbs: TbsCrl = { version: 0n, notBeforeSeconds: 0n, notAfterSeconds: 0n, revokedPublicKeyHashes: [], ranges: [] };
  forEachField(bytes, (number, wireType, value) => {
    if (wireType === 0) {
      if (number === 1) tbs.version = value as bigint;
      else if (number === 2) tbs.notBeforeSeconds = value as bigint;
      else if (number === 3) tbs.notAfterSeconds = value as bigint;
    } else if (wireType === 2) {
      if (number === 4) tbs.revokedPublicKeyHashes.push(Buffer.from(value as Uint8Array));
      else if (number === 5) {
        const range = { issuerPublicKeyHash: Buffer.alloc(0), first: 0n, last: 0n };
        forEachField(value as Uint8Array, (n, w, v) => {
          if (w === 2 && n === 1) range.issuerPublicKeyHash = Buffer.from(v as Uint8Array);
          else if (w === 0 && n === 2) range.first = v as bigint;
          else if (w === 0 && n === 3) range.last = v as bigint;
        });
        tbs.ranges.push(range);
      }
    }
  });
  return tbs;
}

/** der::ParseUint64 on an INTEGER's content octets. */
function parseSerialUint64(content: Buffer): bigint | undefined {
  if (content.length === 0) return undefined;
  const first = content[0] as number;
  if (first & 0x80) return undefined;
  if (content.length > 1 && first === 0 && ((content[1] as number) & 0x80) === 0) return undefined;
  const digits = first === 0 ? content.subarray(1) : content;
  if (digits.length > 8) return undefined;
  return digits.length === 0 ? 0n : BigInt("0x" + digits.toString("hex"));
}

const sha256Hex = (data: Uint8Array): string => createHash("sha256").update(data).digest().toString("latin1");

/** A verified CRL: CastCRLImpl. */
export class CastCrl {
  private readonly notBefore: number;
  private readonly notAfter: number;
  private readonly revokedHashes: Set<string>;
  private readonly revokedSerials = new Map<string, SerialRange[]>();

  constructor(tbs: TbsCrl, notBeforeMs: number, notAfterMs: number, overallNotAfterMs: number) {
    this.notBefore = notBeforeMs;
    this.notAfter = Math.min(notAfterMs, overallNotAfterMs);
    this.revokedHashes = new Set(tbs.revokedPublicKeyHashes.map((h) => h.toString("latin1")));
    for (const range of tbs.ranges) {
      const key = range.issuerPublicKeyHash.toString("latin1");
      const list = this.revokedSerials.get(key) ?? [];
      list.push({ first: range.first, last: range.last });
      this.revokedSerials.set(key, list);
    }
  }

  /**
   * CheckRevocation: false when the chain (target first, trust anchor last) contains a revoked key or serial number,
   * and also when the CRL is not valid at `time` (Chromium hard-fails there).
   */
  checkRevocation(chain: ParsedCertificate[], time: number): boolean {
    if (chain.length === 0) return false;
    if (time < this.notBefore || time > this.notAfter) return false;
    for (let i = 0; i < chain.length; i++) {
      const cert = chain[i] as ParsedCertificate;
      const spkiHash = sha256Hex(cert.spkiTlv);
      if (this.revokedHashes.has(spkiHash)) return false;
      if (i > 0) {
        const ranges = this.revokedSerials.get(spkiHash);
        if (ranges !== undefined) {
          const subordinate = chain[i - 1] as ParsedCertificate;
          const serial = parseSerialUint64(subordinate.serial);
          if (serial === undefined) continue;
          if (ranges.some((r) => r.first <= serial && r.last >= serial)) return false;
        }
      }
    }
    return true;
  }
}

/** The unix-seconds timestamp Chromium verifies the fallback CRL's signer certificate at (kCastFallbackCRLTimestamp). */
export const FALLBACK_CRL_SIGNER_CHECK_TIME_S = 1692255600;

export interface CrlVerificationOptions {
  /** The CRL trust anchors (the Cast CRL Root CA). */
  anchors: ParsedCertificate[];
  isFallback: boolean;
  /** For the fallback only: the "build time" its validity window starts at. */
  fallbackBuildTime?: number;
}

/**
 * ParseAndVerifyCRLUsingCustomTrustStore. Returns undefined when the CRL cannot be parsed or verified, or when it has
 * no supported version.
 */
export function parseAndVerifyCrl(crlProto: Uint8Array, time: number, options: CrlVerificationOptions): CastCrl | undefined {
  let bundle: CrlMessage[];
  try {
    bundle = parseCrlBundle(crlProto);
  } catch {
    return undefined;
  }
  for (const crl of bundle) {
    let tbs: TbsCrl;
    try {
      tbs = parseTbsCrl(crl.tbsCrl ?? Buffer.alloc(0));
    } catch {
      continue;
    }
    if (tbs.version !== 0n) continue;

    let notBeforeMs = Number(tbs.notBeforeSeconds) * 1000;
    let notAfterMs = Number(tbs.notAfterSeconds) * 1000;
    if (options.isFallback) {
      const build = options.fallbackBuildTime as number;
      notBeforeMs = build;
      notAfterMs = build + FALLBACK_CRL_VALIDITY_MS;
    }
    const overall = verifyCrl(crl, tbs, notBeforeMs, notAfterMs, time, options);
    if (overall === undefined) return undefined;
    return new CastCrl(tbs, notBeforeMs, notAfterMs, overall);
  }
  return undefined;
}

/**
 * True when the fallback CRL is intact (it parses and its signer is trusted) but its 20-week window, counted from
 * `fallbackBuildTime`, has lapsed at `time`. This tells "the built-in data is old" from "the data is broken".
 */
export function isFallbackCrlStale(crlProto: Uint8Array, time: number, options: CrlVerificationOptions): boolean {
  const build = options.fallbackBuildTime as number;
  const notAfterMs = build + FALLBACK_CRL_VALIDITY_MS;
  if (time <= notAfterMs) return false;
  return parseAndVerifyCrl(crlProto, notAfterMs, { ...options, isFallback: true }) !== undefined;
}

/** VerifyCRL; returns the overall not-after (ms) or undefined on failure. */
function verifyCrl(crl: CrlMessage, tbs: TbsCrl, notBeforeMs: number, notAfterMs: number, time: number, options: CrlVerificationOptions): number | undefined {
  if (crl.signature === undefined || crl.signerCert === undefined) return undefined;
  let signer: ParsedCertificate;
  try {
    signer = parseCertificate(crl.signerCert);
  } catch (err) {
    if (err instanceof CertParseError || err instanceof DerError) return undefined;
    throw err;
  }
  // crypto::evp::PublicKeyFromBytes accepts any parseable key; only RSA can then verify the SHA-256 PKCS#1 signature.
  let key;
  try {
    key = createPublicKey({ key: signer.spkiTlv, format: "der", type: "spki" });
  } catch {
    return undefined;
  }
  let signatureOk = false;
  try {
    signatureOk = key.asymmetricKeyType === "rsa" && cryptoVerify("sha256", crl.tbsCrl ?? Buffer.alloc(0), key, crl.signature);
  } catch {
    signatureOk = false;
  }
  if (!signatureOk) return undefined;

  const issuerCheckTime = options.isFallback ? FALLBACK_CRL_SIGNER_CHECK_TIME_S * 1000 : time;
  const built = buildAndVerifyPath(signer, [], options.anchors, issuerCheckTime, "any");
  if (built.path === undefined) return undefined;

  if (time < notBeforeMs || time > notAfterMs) return undefined;

  let overall = notAfterMs;
  if (!options.isFallback) {
    for (const cert of built.path) overall = Math.min(overall, cert.notAfter);
  }
  for (const range of tbs.ranges) {
    if (range.last < range.first) return undefined;
  }
  return overall;
}

