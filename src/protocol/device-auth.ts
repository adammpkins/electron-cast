import { CastProtocolError } from "./errors.ts";
import { forEachField, lengthDelimited } from "./proto-wire.ts";

/**
 * The device authentication messages of cast_channel.proto (DeviceAuthMessage and its parts), hand-coded like
 * {@link ./cast-message.ts}. They travel as the binary payload of a CastMessage on the deviceauth namespace.
 */

/** SignatureAlgorithm enum values. */
export const SignatureAlgorithm = { UNSPECIFIED: 0, RSASSA_PKCS1v15: 1, RSASSA_PSS: 2 } as const;
export type SignatureAlgorithm = (typeof SignatureAlgorithm)[keyof typeof SignatureAlgorithm];

/** HashAlgorithm enum values. */
export const HashAlgorithm = { SHA1: 0, SHA256: 1 } as const;
export type HashAlgorithm = (typeof HashAlgorithm)[keyof typeof HashAlgorithm];

/** AuthError.ErrorType enum values. */
export const AuthErrorType = { INTERNAL_ERROR: 0, NO_TLS: 1, SIGNATURE_ALGORITHM_UNAVAILABLE: 2 } as const;
export type AuthErrorType = (typeof AuthErrorType)[keyof typeof AuthErrorType];

/** A decoded AuthResponse. Absent optional fields carry the proto2 defaults. */
export interface AuthResponse {
  signature: Buffer;
  clientAuthCertificate: Buffer;
  intermediateCertificates: Buffer[];
  signatureAlgorithm: number;
  senderNonce: Buffer;
  hashAlgorithm: number;
  crl: Buffer | undefined;
}

/** A decoded DeviceAuthMessage; a device's reply has `response` or `error`. */
export interface DeviceAuthMessage {
  response?: AuthResponse;
  error?: { errorType: number };
}

/** Encode a DeviceAuthMessage carrying only an AuthChallenge (the sender's half). */
export function encodeAuthChallenge(challenge: {
  senderNonce: Uint8Array;
  hashAlgorithm?: HashAlgorithm;
  signatureAlgorithm?: SignatureAlgorithm;
}): Buffer {
  const inner: Buffer[] = [];
  if (challenge.signatureAlgorithm !== undefined) inner.push(Buffer.from([0x08, challenge.signatureAlgorithm]));
  inner.push(lengthDelimited(2, challenge.senderNonce));
  if (challenge.hashAlgorithm !== undefined) inner.push(Buffer.from([0x18, challenge.hashAlgorithm]));
  // DeviceAuthMessage.challenge is field 1.
  return lengthDelimited(1, Buffer.concat(inner));
}

/** Encode an AuthResponse inside a DeviceAuthMessage. Used by tests and fake receivers. */
export function encodeAuthResponse(response: {
  signature: Uint8Array;
  clientAuthCertificate: Uint8Array;
  intermediateCertificates?: Uint8Array[];
  signatureAlgorithm?: number;
  senderNonce?: Uint8Array;
  hashAlgorithm?: number;
  crl?: Uint8Array;
}): Buffer {
  const inner: Buffer[] = [lengthDelimited(1, response.signature), lengthDelimited(2, response.clientAuthCertificate)];
  for (const cert of response.intermediateCertificates ?? []) inner.push(lengthDelimited(3, cert));
  if (response.signatureAlgorithm !== undefined) inner.push(Buffer.from([0x20, response.signatureAlgorithm]));
  if (response.senderNonce !== undefined) inner.push(lengthDelimited(5, response.senderNonce));
  if (response.hashAlgorithm !== undefined) inner.push(Buffer.from([0x30, response.hashAlgorithm]));
  if (response.crl !== undefined) inner.push(lengthDelimited(7, response.crl));
  return lengthDelimited(2, Buffer.concat(inner));
}

/** Encode a DeviceAuthMessage carrying an AuthError. Used by tests and fake receivers. */
export function encodeAuthError(errorType: number): Buffer {
  return lengthDelimited(3, Buffer.from([0x08, errorType]));
}

/** Decode a DeviceAuthMessage, keeping only what a sender needs. Throws {@link CastProtocolError} on malformed input. */
export function decodeDeviceAuthMessage(bytes: Uint8Array): DeviceAuthMessage {
  const out: DeviceAuthMessage = {};
  forEachField(bytes, (number, wireType, value) => {
    if (number === 2 && wireType === 2) out.response = decodeAuthResponse(value as Uint8Array);
    else if (number === 3 && wireType === 2) out.error = decodeAuthError(value as Uint8Array);
  });
  return out;
}

function decodeAuthResponse(bytes: Uint8Array): AuthResponse {
  let signature: Buffer | undefined;
  let clientAuthCertificate: Buffer | undefined;
  const intermediateCertificates: Buffer[] = [];
  const response: AuthResponse = {
    signature: Buffer.alloc(0),
    clientAuthCertificate: Buffer.alloc(0),
    intermediateCertificates,
    signatureAlgorithm: SignatureAlgorithm.RSASSA_PKCS1v15,
    senderNonce: Buffer.alloc(0),
    hashAlgorithm: HashAlgorithm.SHA1,
    crl: undefined,
  };
  forEachField(bytes, (number, wireType, value) => {
    if (wireType === 2) {
      const data = Buffer.from(value as Uint8Array);
      if (number === 1) signature = data;
      else if (number === 2) clientAuthCertificate = data;
      else if (number === 3) intermediateCertificates.push(data);
      else if (number === 5) response.senderNonce = data;
      else if (number === 7) response.crl = data;
    } else if (wireType === 0) {
      if (number === 4) response.signatureAlgorithm = Number(value);
      else if (number === 6) response.hashAlgorithm = Number(value);
    }
  });
  if (signature === undefined) throw new CastProtocolError("AuthResponse is missing required field signature");
  if (clientAuthCertificate === undefined) throw new CastProtocolError("AuthResponse is missing required field client_auth_certificate");
  response.signature = signature;
  response.clientAuthCertificate = clientAuthCertificate;
  return response;
}

function decodeAuthError(bytes: Uint8Array): { errorType: number } {
  let errorType: number | undefined;
  forEachField(bytes, (number, wireType, value) => {
    if (number === 1 && wireType === 0) errorType = Number(value);
  });
  if (errorType === undefined) throw new CastProtocolError("AuthError is missing required field error_type");
  return { errorType };
}
