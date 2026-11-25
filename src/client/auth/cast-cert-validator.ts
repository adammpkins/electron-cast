import { createPublicKey, type KeyObject } from "node:crypto";
import type { CastCrl } from "./crl.ts";
import { buildAndVerifyPath } from "./path-validator.ts";
import { KEY_USAGE_BIT, keyUsageAsserts, OID, parseCertificate, type ParsedCertificate } from "./x509.ts";

/**
 * Cast device certificate verification, ported from components/media_router/common/providers/cast/certificate/
 * cast_cert_validator.cc (VerifyDeviceCertUsingCustomTrustStore, GetValidationDate, CheckTargetCertificate,
 * DetermineDeviceCertificatePolicy) with the CRL_REQUIRED_WITH_FALLBACK policy Chromium's cast_auth_util.cc uses.
 */

export type CastCertError =
  | "OK"
  | "OK_FALLBACK_CRL"
  | "ERR_CERTS_MISSING"
  | "ERR_CERTS_PARSE"
  | "ERR_CERTS_DATE_INVALID"
  | "ERR_CERTS_VERIFY_GENERIC"
  | "ERR_CERTS_RESTRICTIONS"
  | "ERR_CERTS_REVOKED"
  | "ERR_CERTS_REVOKED_BY_FALLBACK_CRL"
  | "ERR_FALLBACK_CRL_INVALID";

/** The device may be restricted to audio by its certificate chain (CastDeviceCertPolicy). */
export type CastDeviceCertPolicy = "unrestricted" | "audio_only";

export interface DeviceCertVerification {
  error: CastCertError;
  /** Set when the error is OK or OK_FALLBACK_CRL (and set earlier too, as in Chromium). */
  policy: CastDeviceCertPolicy;
  /** The device certificate's public key, for checking the challenge signature. */
  publicKey: KeyObject | undefined;
  /** Detail for diagnostics. */
  detail: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** Certificates valid for more than this count as long-term (GetValidationDate). */
const MIN_LONG_TERM_VALIDITY_MS = 5 * 365 * DAY_MS;
/** How far past the leaf's notAfter the long-term grace period reaches. */
const MAX_GRACE_WINDOW_MS = 15 * 365 * DAY_MS;

/**
 * GetValidationDate: for long-term certificate chains that have just expired (within 15 years of the leaf's notAfter),
 * validate as of a week before the earliest expiry instead of "now". See b/416790717 in Chromium's source.
 */
function getValidationDate(target: ParsedCertificate, parsed: ParsedCertificate[], time: number): number {
  let minNotAfter = Infinity;
  let minDuration = Infinity;
  for (const cert of parsed) {
    minNotAfter = Math.min(minNotAfter, cert.notAfter);
    minDuration = Math.min(minDuration, cert.notAfter - cert.notBefore);
  }
  const maxValidity = target.notAfter + MAX_GRACE_WINDOW_MS;
  if (minNotAfter <= time && time <= maxValidity && minDuration > MIN_LONG_TERM_VALIDITY_MS) return minNotAfter - 7 * DAY_MS;
  return time;
}

export interface DeviceCertOptions {
  anchors: ParsedCertificate[];
  /** The CRL the device supplied, if it parsed and verified (undefined otherwise, like a null CastCRL). */
  crl: CastCrl | undefined;
  /** The built-in fallback CRL, if it parsed and verified. */
  fallbackCrl: CastCrl | undefined;
}

/** VerifyDeviceCertUsingCustomTrustStore with CRLPolicy::CRL_REQUIRED_WITH_FALLBACK. */
export function verifyDeviceCert(certs: Uint8Array[], time: number, options: DeviceCertOptions): DeviceCertVerification {
  const result = (error: CastCertError, detail: string, extra: Partial<DeviceCertVerification> = {}): DeviceCertVerification => ({
    error,
    policy: "unrestricted",
    publicKey: undefined,
    detail,
    ...extra,
  });
  if (certs.length === 0) return result("ERR_CERTS_MISSING", "no certificates");

  const parsed: ParsedCertificate[] = [];
  for (const der of certs) {
    try {
      parsed.push(parseCertificate(der));
    } catch (err) {
      return result("ERR_CERTS_PARSE", `certificate does not parse: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const target = parsed[0] as ParsedCertificate;

  const validationDate = getValidationDate(target, parsed, time);
  const built = buildAndVerifyPath(target, parsed.slice(1), options.anchors, validationDate, "client-auth");
  if (built.path === undefined) {
    const detail = built.errors === undefined ? "no path to a trusted Cast root" : built.errors.messages.join("; ");
    return result(built.errors?.date === true ? "ERR_CERTS_DATE_INVALID" : "ERR_CERTS_VERIFY_GENERIC", detail, { policy: "unrestricted" });
  }
  const path = built.path;

  const audioOnly = path.some((cert) => cert.policyOids?.includes(OID.CAST_AUDIO_ONLY_POLICY) === true);
  const policy: CastDeviceCertPolicy = audioOnly ? "audio_only" : "unrestricted";

  // CheckTargetCertificate: digitalSignature key usage, a common name, a usable public key.
  let publicKey: KeyObject | undefined;
  try {
    publicKey = createPublicKey({ key: target.spkiTlv, format: "der", type: "spki" });
  } catch {
    publicKey = undefined;
  }
  if (
    target.keyUsage === undefined ||
    !keyUsageAsserts(target.keyUsage, KEY_USAGE_BIT.DIGITAL_SIGNATURE) ||
    target.commonName === undefined ||
    publicKey === undefined
  ) {
    return result("ERR_CERTS_RESTRICTIONS", "the device certificate lacks digitalSignature key usage, a common name or a usable key", { policy });
  }

  const ok = (error: CastCertError, detail: string) => result(error, detail, { policy, publicKey });

  // Revocation. Note the CRL checks use the real time, not the (possibly adjusted) validation date.
  if (options.fallbackCrl !== undefined) {
    if (!options.fallbackCrl.checkRevocation(path, time)) return ok("ERR_CERTS_REVOKED_BY_FALLBACK_CRL", "revoked by the fallback CRL");
  } else if (options.crl === undefined) {
    return ok("ERR_FALLBACK_CRL_INVALID", "no valid CRL from the device and no valid fallback CRL");
  }
  if (options.crl === undefined) return ok("OK_FALLBACK_CRL", "accepted on the fallback CRL");
  if (!options.crl.checkRevocation(path, time)) return ok("ERR_CERTS_REVOKED", "revoked by the device's CRL");
  return ok("OK", "");
}
