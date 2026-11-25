import { randomBytes, verify as cryptoVerify } from "node:crypto";
import { CastProtocolError } from "../../protocol/errors.ts";
import { PayloadType } from "../../protocol/cast-message.ts";
import { decodeDeviceAuthMessage, encodeAuthChallenge, HashAlgorithm } from "../../protocol/device-auth.ts";
import { CastAuthError } from "../errors.ts";
import { verifyDeviceCert, type CastCertError, type CastDeviceCertPolicy } from "./cast-cert-validator.ts";
import { isFallbackCrlStale, parseAndVerifyCrl, type CastCrl } from "./crl.ts";
import {
  CAST_CRL_ROOT_CA_B64,
  CAST_FALLBACK_CRL_B64,
  CAST_ROOT_CA_B64,
  EUREKA_ROOT_CA_B64,
  FALLBACK_CRL_BUILD_TIME,
} from "./trust-data.ts";
import { parseCertificate, type ParsedCertificate } from "./x509.ts";

/**
 * The sender side of Cast device authentication, ported from components/media_router/common/providers/cast/channel/
 * cast_auth_util.cc (AuthenticateChallengeReply, VerifyCredentialsImpl, VerifyTLSCertificate, ParseAuthMessage,
 * VerifyAndMapDigestAlgorithm, AuthContext::VerifySenderNonce) and cast_message_util.cc (CreateAuthChallengeMessage).
 */

/** Chromium's kMaxSelfSignedCertLifetimeInDays. */
const MAX_SELF_SIGNED_CERT_LIFETIME_MS = 4 * 24 * 60 * 60 * 1000;
/** Chromium's kNonceSizeInBytes. */
const NONCE_SIZE = 16;

/** Replacements for the trust anchors and the clock in device authentication. For tests and private Cast deployments. */
export interface DeviceAuthOptions {
  /** Verification time, epoch milliseconds. Defaults to now. */
  now?: number;
  /** Trust anchors (DER) replacing the Cast Root CA and Eureka Root CA. For tests and private Cast deployments. */
  roots?: Uint8Array[];
  /** CRL trust anchors (DER) replacing the Cast CRL Root CA. */
  crlRoots?: Uint8Array[];
  /** Replacement fallback CRL (a serialized CrlBundle), or `null` for none. */
  fallbackCrl?: Uint8Array | null;
  /** The "build time" the fallback CRL's 20-week window starts at, epoch milliseconds. */
  fallbackCrlBuildTime?: number;
}

/** What device authentication established about a device, available as `CastClient.deviceAuth` once connected. */
export interface DeviceAuthResult {
  policy: CastDeviceCertPolicy;
  hashAlgorithm: "sha1" | "sha256";
  /** False when the device's reply did not echo our nonce; Chromium records this and carries on. */
  nonceEchoed: boolean;
  /** True when the device sent no usable CRL and the built-in fallback CRL was used instead. */
  usedFallbackCrl: boolean;
  /**
   * False only when the built-in fallback CRL had expired and the device sent no valid CRL, so the revocation check was
   * skipped (Chromium would refuse the device). Revocation by a device CRL or a still-valid fallback CRL is always checked.
   */
  revocationChecked: boolean;
}

/** A challenge: the nonce and the DeviceAuthMessage bytes that go in the CastMessage's binary payload. */
export function createAuthChallenge(): { nonce: Buffer; payload: Buffer } {
  const nonce = randomBytes(NONCE_SIZE);
  return { nonce, payload: encodeAuthChallenge({ senderNonce: nonce, hashAlgorithm: HashAlgorithm.SHA256 }) };
}

let defaultAnchors: ParsedCertificate[] | undefined;
let defaultCrlAnchors: ParsedCertificate[] | undefined;

const parseAll = (ders: Uint8Array[]): ParsedCertificate[] => ders.map((d) => parseCertificate(d));

function anchorsFor(options: DeviceAuthOptions): ParsedCertificate[] {
  if (options.roots !== undefined) return parseAll(options.roots);
  defaultAnchors ??= parseAll([Buffer.from(CAST_ROOT_CA_B64, "base64"), Buffer.from(EUREKA_ROOT_CA_B64, "base64")]);
  return defaultAnchors;
}

function crlAnchorsFor(options: DeviceAuthOptions): ParsedCertificate[] {
  if (options.crlRoots !== undefined) return parseAll(options.crlRoots);
  defaultCrlAnchors ??= parseAll([Buffer.from(CAST_CRL_ROOT_CA_B64, "base64")]);
  return defaultCrlAnchors;
}

/** The decoded fields of a binary CastMessage reply on the deviceauth namespace. */
export interface AuthReplyMessage {
  payloadType: number;
  payloadBinary: Buffer | undefined;
}

const REASONS: Record<CastCertError, (detail: string) => CastAuthError | undefined> = {
  OK: () => undefined,
  OK_FALLBACK_CRL: () => undefined,
  OK_FALLBACK_CRL_STALE: () => undefined,
  ERR_CERTS_MISSING: (d) => new CastAuthError("invalid_certificate", `no device certificate: ${d}`),
  ERR_CERTS_PARSE: (d) => new CastAuthError("invalid_certificate", d),
  ERR_CERTS_DATE_INVALID: (d) => new CastAuthError("invalid_certificate", `failed date validity check: ${d}`),
  ERR_CERTS_VERIFY_GENERIC: (d) => new CastAuthError("untrusted_chain", `the certificate chain is not trusted: ${d}`),
  ERR_CERTS_RESTRICTIONS: (d) => new CastAuthError("invalid_certificate", d),
  ERR_CERTS_REVOKED: (d) => new CastAuthError("revoked", d),
  ERR_CERTS_REVOKED_BY_FALLBACK_CRL: (d) => new CastAuthError("revoked", d),
  ERR_FALLBACK_CRL_INVALID: (d) => new CastAuthError("crl_invalid", d),
};

/**
 * AuthenticateChallengeReply. Throws {@link CastAuthError} unless the reply proves the TLS peer is a genuine,
 * Google-certified Cast device.
 *
 * `peerCertDer` is the DER of the TLS certificate the device presented on this connection; the signature in the
 * reply is over `senderNonce || peerCertDer`, which binds the proof to this TLS session's certificate.
 */
export function authenticateChallengeReply(
  reply: AuthReplyMessage,
  peerCertDer: Uint8Array,
  nonce: Uint8Array,
  options: DeviceAuthOptions = {},
): DeviceAuthResult {
  const now = options.now ?? Date.now();

  // ParseAuthMessage
  if (reply.payloadType !== PayloadType.BINARY) throw new CastAuthError("malformed_reply", "wrong payload type in the challenge reply");
  if (reply.payloadBinary === undefined) throw new CastAuthError("malformed_reply", "the challenge reply has no binary payload");
  let message;
  try {
    message = decodeDeviceAuthMessage(reply.payloadBinary);
  } catch (err) {
    if (err instanceof CastProtocolError) throw new CastAuthError("malformed_reply", `cannot parse the challenge reply: ${err.message}`);
    throw err;
  }
  if (message.error !== undefined) throw new CastAuthError("device_error", `the device answered with auth error ${message.error.errorType}`);
  const response = message.response;
  if (response === undefined) throw new CastAuthError("malformed_reply", "the challenge reply has no response");

  // VerifyTLSCertificate: the TLS certificate's validity period is repurposed as the signature's lifetime.
  let peer: ParsedCertificate;
  try {
    peer = parseCertificate(peerCertDer);
  } catch (err) {
    throw new CastAuthError("tls_certificate_invalid", `the TLS certificate does not parse: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (peer.notBefore > now) throw new CastAuthError("tls_certificate_invalid", "the TLS certificate's valid start date is in the future");
  if (peer.notAfter < now) throw new CastAuthError("tls_certificate_invalid", "the TLS certificate has expired");
  if (peer.notAfter > now + MAX_SELF_SIGNED_CERT_LIFETIME_MS) throw new CastAuthError("tls_certificate_invalid", "the TLS certificate's lifetime is too long");

  // AuthContext::VerifySenderNonce records a missing or different nonce but does not fail.
  const nonceEchoed = Buffer.from(nonce).equals(response.senderNonce);

  // VerifyCredentialsImpl
  const signatureInput = Buffer.concat([response.senderNonce, peerCertDer]);
  const anchors = anchorsFor(options);
  const crlAnchors = crlAnchorsFor(options);

  let crl: CastCrl | undefined;
  if (response.crl !== undefined && response.crl.length > 0) {
    crl = parseAndVerifyCrl(response.crl, now, { anchors: crlAnchors, isFallback: false });
  }
  const fallbackBytes = options.fallbackCrl === undefined ? Buffer.from(CAST_FALLBACK_CRL_B64, "base64") : options.fallbackCrl;
  const fallbackOptions = { anchors: crlAnchors, isFallback: true, fallbackBuildTime: options.fallbackCrlBuildTime ?? FALLBACK_CRL_BUILD_TIME };
  const fallbackCrl = fallbackBytes === null ? undefined : parseAndVerifyCrl(fallbackBytes, now, fallbackOptions);
  const fallbackCrlStale = fallbackBytes !== null && fallbackCrl === undefined && isFallbackCrlStale(fallbackBytes, now, fallbackOptions);

  const chain = [response.clientAuthCertificate, ...response.intermediateCertificates];
  const verified = verifyDeviceCert(chain, now, { anchors, crl, fallbackCrl, fallbackCrlStale });
  const failure = REASONS[verified.error](verified.detail);
  if (failure !== undefined) throw failure;

  if (response.signature.length === 0 && signatureInput.length > 0) throw new CastAuthError("bad_signature", "the signature is empty");

  let hash: "sha1" | "sha256";
  if (response.hashAlgorithm === HashAlgorithm.SHA1) hash = "sha1";
  else if (response.hashAlgorithm === HashAlgorithm.SHA256) hash = "sha256";
  else throw new CastAuthError("unsupported_algorithm", `unsupported hash algorithm ${response.hashAlgorithm}`);

  // CertVerificationContextImpl::VerifySignatureOverData: RSASSA-PKCS1-v1_5 with the chosen digest, RSA keys only.
  const key = verified.publicKey;
  let signatureOk = false;
  try {
    signatureOk = key !== undefined && key.asymmetricKeyType === "rsa" && cryptoVerify(hash, signatureInput, key, response.signature);
  } catch {
    signatureOk = false;
  }
  if (!signatureOk) throw new CastAuthError("bad_signature", "failed verifying the signature over the TLS certificate");

  return {
    policy: verified.policy,
    hashAlgorithm: hash,
    nonceEchoed,
    usedFallbackCrl: verified.error === "OK_FALLBACK_CRL",
    revocationChecked: verified.error !== "OK_FALLBACK_CRL_STALE",
  };
}
