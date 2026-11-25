import { constants, createPublicKey, verify as cryptoVerify, type KeyObject } from "node:crypto";
import {
  children,
  contextTag,
  DerError,
  DerReader,
  oidString,
  parseBitString,
  parseBoolean,
  parseTime,
  parseUnsignedInteger,
  Tag,
  type Tlv,
} from "./der.ts";
import { type GeneralNames, NameConstraints, normalizeName, type NormalizedName, parseGeneralNames, namesEqual } from "./names.ts";

/**
 * X.509 parsing for the Cast certificate verifier. It follows BoringSSL's pki library (pki/parse_certificate.cc,
 * pki/parsed_certificate.cc, pki/signature_algorithm.cc, pki/verify_signed_data.cc), which Chromium's Cast
 * verification runs on. Node exposes none of the extensions that matter here (key usage bits, policies,
 * name constraints, path length), hence the parser.
 */

export class CertParseError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CertParseError";
  }
}

export const OID = {
  BASIC_CONSTRAINTS: "2.5.29.19",
  KEY_USAGE: "2.5.29.15",
  EXT_KEY_USAGE: "2.5.29.37",
  NAME_CONSTRAINTS: "2.5.29.30",
  SUBJECT_ALT_NAME: "2.5.29.17",
  CERTIFICATE_POLICIES: "2.5.29.32",
  POLICY_MAPPINGS: "2.5.29.33",
  POLICY_CONSTRAINTS: "2.5.29.36",
  INHIBIT_ANY_POLICY: "2.5.29.54",
  MS_APPLICATION_POLICIES: "1.3.6.1.4.1.311.21.10",
  ANY_POLICY: "2.5.29.32.0",
  ANY_EKU: "2.5.29.37.0",
  CLIENT_AUTH: "1.3.6.1.5.5.7.3.2",
  COMMON_NAME: "2.5.4.3",
  /** The Cast audio-only policy, 1.3.6.1.4.1.11129.2.5.2 (cast_cert_validator.cc, AudioOnlyPolicyOid). */
  CAST_AUDIO_ONLY_POLICY: "1.3.6.1.4.1.11129.2.5.2",
} as const;

export const KEY_USAGE_BIT = { DIGITAL_SIGNATURE: 0, KEY_CERT_SIGN: 5 } as const;

// --- Signature algorithms -------------------------------------------------------------------------------------

export type HashName = "sha1" | "sha256" | "sha384" | "sha512";

export interface SignatureAlgorithm {
  family: "rsa-pkcs1" | "ecdsa" | "rsa-pss";
  hash: HashName;
}

const SIGNATURE_OIDS: Record<string, { family: SignatureAlgorithm["family"]; hash: HashName; params: "null-or-absent" | "absent" }> = {
  "1.2.840.113549.1.1.5": { family: "rsa-pkcs1", hash: "sha1", params: "null-or-absent" },
  "1.2.840.113549.1.1.11": { family: "rsa-pkcs1", hash: "sha256", params: "null-or-absent" },
  "1.2.840.113549.1.1.12": { family: "rsa-pkcs1", hash: "sha384", params: "null-or-absent" },
  "1.2.840.113549.1.1.13": { family: "rsa-pkcs1", hash: "sha512", params: "null-or-absent" },
  // sha1WithRSASignature, an older OID for the same algorithm that BoringSSL also accepts.
  "1.3.14.3.2.29": { family: "rsa-pkcs1", hash: "sha1", params: "null-or-absent" },
  "1.2.840.10045.4.1": { family: "ecdsa", hash: "sha1", params: "absent" },
  "1.2.840.10045.4.3.2": { family: "ecdsa", hash: "sha256", params: "absent" },
  "1.2.840.10045.4.3.3": { family: "ecdsa", hash: "sha384", params: "absent" },
  "1.2.840.10045.4.3.4": { family: "ecdsa", hash: "sha512", params: "absent" },
};
const OID_RSASSA_PSS = "1.2.840.113549.1.1.10";
const OID_MGF1 = "1.2.840.113549.1.1.8";
const HASH_OIDS: Record<string, HashName> = {
  "1.3.14.3.2.26": "sha1",
  "2.16.840.1.101.3.4.2.1": "sha256",
  "2.16.840.1.101.3.4.2.2": "sha384",
  "2.16.840.1.101.3.4.2.3": "sha512",
};
const PSS_SALT: Record<HashName, number> = { sha1: 20, sha256: 32, sha384: 48, sha512: 64 };

/** ParseAlgorithmIdentifier: the OID and the parameters TLV, if any. */
function parseAlgorithmIdentifier(tlv: Tlv): { oid: string; params: Tlv | undefined } | undefined {
  try {
    if (tlv.tag !== Tag.SEQUENCE) return undefined;
    const r = new DerReader(tlv.value);
    const oid = oidString(r.expect(Tag.OID).value);
    const params = r.hasMore ? r.read() : undefined;
    r.end();
    return { oid, params };
  } catch {
    return undefined;
  }
}

const isNull = (t: Tlv | undefined): boolean => t !== undefined && t.tag === Tag.NULL && t.value.length === 0;

function parseHashAlgorithm(tlv: Tlv): HashName | undefined {
  const alg = parseAlgorithmIdentifier(tlv);
  if (alg === undefined) return undefined;
  if (alg.params !== undefined && !isNull(alg.params)) return undefined;
  return HASH_OIDS[alg.oid];
}

function parseRsaPss(params: Tlv | undefined): SignatureAlgorithm | undefined {
  if (params === undefined || params.tag !== Tag.SEQUENCE) return undefined;
  try {
    const r = new DerReader(params.value);
    const hash = parseHashAlgorithm(new DerReader(r.expect(contextTag(0, true)).value).read());
    const mgf = parseAlgorithmIdentifier(new DerReader(r.expect(contextTag(1, true)).value).read());
    const saltReader = new DerReader(r.expect(contextTag(2, true)).value);
    const salt = parseUnsignedInteger(saltReader.read());
    saltReader.end();
    r.end();
    if (hash === undefined || mgf === undefined || mgf.oid !== OID_MGF1 || mgf.params === undefined) return undefined;
    if (parseHashAlgorithm(mgf.params) !== hash) return undefined;
    if (hash === "sha1" || salt !== BigInt(PSS_SALT[hash])) return undefined;
    return { family: "rsa-pss", hash };
  } catch {
    return undefined;
  }
}

/** ParseSignatureAlgorithm. */
export function parseSignatureAlgorithm(tlv: Tlv): SignatureAlgorithm | undefined {
  const alg = parseAlgorithmIdentifier(tlv);
  if (alg === undefined) return undefined;
  const entry = SIGNATURE_OIDS[alg.oid];
  if (entry !== undefined) {
    const ok = entry.params === "absent" ? alg.params === undefined : alg.params === undefined || isNull(alg.params);
    return ok ? { family: entry.family, hash: entry.hash } : undefined;
  }
  if (alg.oid === OID_RSASSA_PSS) return parseRsaPss(alg.params);
  return undefined;
}

export const sameSignatureAlgorithm = (a: SignatureAlgorithm, b: SignatureAlgorithm): boolean => a.family === b.family && a.hash === b.hash;

/** VerifySignedData: false for any mismatch between the algorithm and the key. */
export function verifySignedData(alg: SignatureAlgorithm, data: Uint8Array, signature: Uint8Array, key: KeyObject): boolean {
  try {
    if (alg.family === "ecdsa") {
      if (key.asymmetricKeyType !== "ec") return false;
      return cryptoVerify(alg.hash, data, key, signature);
    }
    if (key.asymmetricKeyType !== "rsa") return false;
    if (alg.family === "rsa-pkcs1") return cryptoVerify(alg.hash, data, key, signature);
    return cryptoVerify(
      alg.hash,
      data,
      { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: PSS_SALT[alg.hash] },
      signature,
    );
  } catch {
    return false;
  }
}

// --- Certificates ---------------------------------------------------------------------------------------------

export interface PolicyMapping {
  issuerDomainPolicy: string;
  subjectDomainPolicy: string;
}

export interface Extension {
  oid: string;
  critical: boolean;
  value: Buffer;
}

export interface ParsedCertificate {
  der: Buffer;
  version: 1 | 2 | 3;
  tbsTlv: Buffer;
  tbsSignatureAlgorithmTlv: Buffer;
  signatureAlgorithmTlv: Buffer;
  /** Undefined when the algorithm is not one BoringSSL recognizes. */
  signatureAlgorithm: SignatureAlgorithm | undefined;
  signatureValue: Buffer;
  /** The serial number's content octets. */
  serial: Buffer;
  issuerContent: Buffer;
  subjectContent: Buffer;
  normalizedIssuer: NormalizedName;
  normalizedSubject: NormalizedName;
  /** Epoch milliseconds. */
  notBefore: number;
  notAfter: number;
  spkiTlv: Buffer;
  extensions: Map<string, Extension>;
  basicConstraints: { isCa: boolean; pathLen: number | undefined } | undefined;
  keyUsage: { bytes: Buffer; unusedBits: number } | undefined;
  extendedKeyUsage: string[] | undefined;
  policyOids: string[] | undefined;
  policyMappings: PolicyMapping[] | undefined;
  policyConstraints: { requireExplicitPolicy: number | undefined; inhibitPolicyMapping: number | undefined } | undefined;
  inhibitAnyPolicy: number | undefined;
  nameConstraints: NameConstraints | undefined;
  subjectAltNames: GeneralNames | undefined;
  /** The common name from the subject, if present. */
  commonName: string | undefined;
}

const CPS_QUALIFIER_OID = "1.3.6.1.5.5.7.2.1";
const USER_NOTICE_QUALIFIER_OID = "1.3.6.1.5.5.7.2.2";

function fail(message: string): never {
  throw new CertParseError(message);
}

/**
 * ParseCertificatePoliciesExtensionOids. With `strictQualifiers`, a qualifier other than CPS or User Notice is an
 * error: that is how BoringSSL decides whether a critical certificatePolicies extension is "handled".
 */
function parsePolicyOids(value: Buffer, strictQualifiers: boolean): string[] {
  const r = new DerReader(value);
  const seq = r.expect(Tag.SEQUENCE);
  r.end();
  const infos = children(seq);
  if (infos.length === 0) throw new DerError("certificatePolicies is empty");
  const oids: string[] = [];
  for (const info of infos) {
    const ir = new DerReader(info.value);
    if (info.tag !== Tag.SEQUENCE) throw new DerError("bad PolicyInformation");
    const oid = oidString(ir.expect(Tag.OID).value);
    if (oids.includes(oid)) throw new DerError("duplicate policy OID");
    oids.push(oid);
    if (ir.hasMore) {
      const qualifiers = children(ir.expect(Tag.SEQUENCE));
      for (const q of qualifiers) {
        if (q.tag !== Tag.SEQUENCE) throw new DerError("bad PolicyQualifierInfo");
        const qr = new DerReader(q.value);
        const qid = oidString(qr.expect(Tag.OID).value);
        qr.read();
        qr.end();
        if (strictQualifiers && qid !== CPS_QUALIFIER_OID && qid !== USER_NOTICE_QUALIFIER_OID) throw new DerError("unknown policy qualifier");
      }
    }
    ir.end();
  }
  return oids;
}

/** Whether a critical certificatePolicies extension counts as handled (only known qualifiers). */
export function criticalPoliciesHandled(value: Buffer): boolean {
  try {
    parsePolicyOids(value, true);
    return true;
  } catch {
    return false;
  }
}

const uint8 = (tlv: Tlv): number => {
  const v = parseUnsignedInteger(tlv);
  if (v > 255n) throw new DerError("value exceeds uint8");
  return Number(v);
};

function parseExtensions(tlv: Tlv): Map<string, Extension> {
  const out = new Map<string, Extension>();
  const seq = new DerReader(tlv.value).expect(Tag.SEQUENCE);
  const items = children(seq);
  if (items.length === 0) throw new DerError("empty extensions");
  for (const item of items) {
    if (item.tag !== Tag.SEQUENCE) throw new DerError("bad Extension");
    const r = new DerReader(item.value);
    const oid = oidString(r.expect(Tag.OID).value);
    let critical = false;
    const crit = r.optional(Tag.BOOLEAN);
    if (crit !== undefined) {
      critical = parseBoolean(crit);
      if (!critical) throw new DerError("DEFAULT critical value must be omitted");
    }
    const value = r.expect(Tag.OCTET_STRING).value;
    r.end();
    if (out.has(oid)) throw new DerError("duplicate extension");
    out.set(oid, { oid, critical, value });
  }
  return out;
}

/** ParsedCertificate::Create. Throws {@link CertParseError}. */
export function parseCertificate(der: Uint8Array): ParsedCertificate {
  try {
    return parseCertificateInner(Buffer.from(der.buffer, der.byteOffset, der.byteLength));
  } catch (err) {
    if (err instanceof CertParseError) throw err;
    throw new CertParseError(err instanceof Error ? err.message : String(err), { cause: err });
  }
}

function parseCertificateInner(der: Buffer): ParsedCertificate {
  const top = new DerReader(der);
  const cert = top.expect(Tag.SEQUENCE);
  top.end();
  const cr = new DerReader(cert.value);
  const tbs = cr.expect(Tag.SEQUENCE);
  const sigAlg = cr.read();
  const sigBits = parseBitString(cr.expect(Tag.BIT_STRING));
  cr.end();
  if (sigBits.unusedBits !== 0) fail("signature BIT STRING has unused bits");

  const t = new DerReader(tbs.value);
  let version: 1 | 2 | 3 = 1;
  const v = t.optional(contextTag(0, true));
  if (v !== undefined) {
    const vr = new DerReader(v.value);
    const n = vr.read();
    vr.end();
    // INTEGER 0, 1 or 2; an explicit v1 is not DER (DEFAULT must be omitted).
    if (n.tag !== Tag.INTEGER || n.value.length !== 1) fail("bad version");
    const num = n.value[0] as number;
    if (num !== 1 && num !== 2) fail("unsupported version");
    version = (num + 1) as 2 | 3;
  }
  const serial = t.expect(Tag.INTEGER);
  if (serial.value.length === 0 || serial.value.length > 21) fail("bad serial number");
  const tbsSigAlg = t.read();
  const issuer = t.expect(Tag.SEQUENCE);
  const validity = new DerReader(t.expect(Tag.SEQUENCE).value);
  const notBefore = parseTime(validity.read());
  const notAfter = parseTime(validity.read());
  validity.end();
  const subject = t.expect(Tag.SEQUENCE);
  const spki = t.expect(Tag.SEQUENCE);
  if (version >= 2) {
    t.optional(contextTag(1, false));
    t.optional(contextTag(2, false));
  }
  const extTlv = version === 3 ? t.optional(contextTag(3, true)) : undefined;
  t.end();

  const extensions = extTlv === undefined ? new Map<string, Extension>() : parseExtensions(extTlv);
  const out: ParsedCertificate = {
    der,
    version,
    tbsTlv: tbs.raw,
    tbsSignatureAlgorithmTlv: tbsSigAlg.raw,
    signatureAlgorithmTlv: sigAlg.raw,
    signatureAlgorithm: parseSignatureAlgorithm(sigAlg),
    signatureValue: sigBits.bytes,
    serial: serial.value,
    issuerContent: issuer.value,
    subjectContent: subject.value,
    normalizedIssuer: normalizeName(issuer.value),
    normalizedSubject: normalizeName(subject.value),
    notBefore,
    notAfter,
    spkiTlv: spki.raw,
    extensions,
    basicConstraints: undefined,
    keyUsage: undefined,
    extendedKeyUsage: undefined,
    policyOids: undefined,
    policyMappings: undefined,
    policyConstraints: undefined,
    inhibitAnyPolicy: undefined,
    nameConstraints: undefined,
    subjectAltNames: undefined,
    commonName: undefined,
  };

  const ext = (oid: string) => extensions.get(oid);
  const bc = ext(OID.BASIC_CONSTRAINTS);
  if (bc !== undefined) {
    const r = new DerReader(new DerReader(bc.value).expect(Tag.SEQUENCE).value);
    const ca = r.optional(Tag.BOOLEAN);
    const isCa = ca === undefined ? false : parseBoolean(ca);
    const pl = r.optional(Tag.INTEGER);
    r.end();
    out.basicConstraints = { isCa, pathLen: pl === undefined ? undefined : uint8(pl) };
  }
  const ku = ext(OID.KEY_USAGE);
  if (ku !== undefined) {
    const r = new DerReader(ku.value);
    const bits = parseBitString(r.expect(Tag.BIT_STRING));
    r.end();
    if (bits.bytes.every((b) => b === 0)) fail("key usage asserts no bits");
    out.keyUsage = bits;
  }
  const eku = ext(OID.EXT_KEY_USAGE);
  if (eku !== undefined) {
    const r = new DerReader(eku.value);
    const items = children(r.expect(Tag.SEQUENCE));
    r.end();
    if (items.length === 0) fail("empty extendedKeyUsage");
    out.extendedKeyUsage = items.map((i) => {
      if (i.tag !== Tag.OID) fail("bad extendedKeyUsage");
      return oidString(i.value);
    });
  }
  const san = ext(OID.SUBJECT_ALT_NAME);
  if (san !== undefined) out.subjectAltNames = parseGeneralNames(san.value);
  const nc = ext(OID.NAME_CONSTRAINTS);
  if (nc !== undefined) out.nameConstraints = NameConstraints.parse(nc.value, nc.critical);
  const pol = ext(OID.CERTIFICATE_POLICIES);
  if (pol !== undefined) out.policyOids = parsePolicyOids(pol.value, false);
  const pm = ext(OID.POLICY_MAPPINGS);
  if (pm !== undefined) {
    const r = new DerReader(pm.value);
    const items = children(r.expect(Tag.SEQUENCE));
    r.end();
    if (items.length === 0) fail("empty policyMappings");
    out.policyMappings = items.map((i) => {
      const ir = new DerReader(i.value);
      const issuerDomainPolicy = oidString(ir.expect(Tag.OID).value);
      const subjectDomainPolicy = oidString(ir.expect(Tag.OID).value);
      ir.end();
      return { issuerDomainPolicy, subjectDomainPolicy };
    });
  }
  const pc = ext(OID.POLICY_CONSTRAINTS);
  if (pc !== undefined) {
    const r = new DerReader(new DerReader(pc.value).expect(Tag.SEQUENCE).value);
    const req = r.optional(0x80);
    const inh = r.optional(0x81);
    r.end();
    if (req === undefined && inh === undefined) fail("empty policyConstraints");
    const implicit = (x: Tlv | undefined): number | undefined => (x === undefined ? undefined : uint8({ tag: Tag.INTEGER, value: x.value, raw: x.raw }));
    out.policyConstraints = { requireExplicitPolicy: implicit(req), inhibitPolicyMapping: implicit(inh) };
  }
  const iap = ext(OID.INHIBIT_ANY_POLICY);
  if (iap !== undefined) {
    const r = new DerReader(iap.value);
    out.inhibitAnyPolicy = uint8(r.expect(Tag.INTEGER));
    r.end();
  }

  // The subject's common name: the first CN attribute (GetCommonNameFromSubject in cast_cert_validator.cc).
  out.commonName = firstCommonName(subject.value);
  return out;
}

function firstCommonName(nameContent: Buffer): string | undefined {
  try {
    const r = new DerReader(nameContent);
    while (r.hasMore) {
      for (const ava of children(r.expect(Tag.SET))) {
        const ar = new DerReader(ava.value);
        const oid = oidString(ar.expect(Tag.OID).value);
        const value = ar.read();
        if (oid === OID.COMMON_NAME) {
          if (value.tag === Tag.BMP_STRING) return Buffer.from(value.value).swap16().toString("utf16le");
          return value.value.toString("utf8");
        }
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export const isSelfIssued = (cert: ParsedCertificate): boolean => namesEqual(cert.normalizedSubject, cert.normalizedIssuer);

export function keyUsageAsserts(ku: { bytes: Buffer }, bit: number): boolean {
  const byte = ku.bytes[bit >> 3];
  return byte !== undefined && (byte & (0x80 >> (bit & 7))) !== 0;
}

// --- Public keys ----------------------------------------------------------------------------------------------

const ACCEPTABLE_EC_CURVES = new Set(["prime256v1", "secp384r1", "secp521r1"]);

/**
 * SimplePathBuilderDelegate::IsPublicKeyAcceptable as Chromium's CastPathBuilderDelegate configures it: RSA keys of at
 * least `minRsaBits` bits, or ECDSA keys on P-256, P-384 or P-521.
 */
export function parseAcceptablePublicKey(spkiTlv: Buffer, minRsaBits = 2048): KeyObject | undefined {
  let key: KeyObject;
  try {
    key = createPublicKey({ key: spkiTlv, format: "der", type: "spki" });
  } catch {
    return undefined;
  }
  if (key.asymmetricKeyType === "rsa") {
    const bits = key.asymmetricKeyDetails?.modulusLength;
    return bits !== undefined && bits >= minRsaBits ? key : undefined;
  }
  if (key.asymmetricKeyType === "ec") {
    const curve = key.asymmetricKeyDetails?.namedCurve;
    return curve !== undefined && ACCEPTABLE_EC_CURVES.has(curve) ? key : undefined;
  }
  return undefined;
}
