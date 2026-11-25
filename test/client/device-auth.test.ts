import assert from "node:assert/strict";
import { createHash, createSign } from "node:crypto";
import { test } from "node:test";
import { authenticateChallengeReply, type DeviceAuthOptions } from "../../src/client/auth/cast-auth.ts";
import { parseAndVerifyCrl } from "../../src/client/auth/crl.ts";
import { parseCertificate } from "../../src/client/auth/x509.ts";
import { CAST_CRL_ROOT_CA_B64, CAST_FALLBACK_CRL_B64, CAST_ROOT_CA_B64, EUREKA_ROOT_CA_B64 } from "../../src/client/auth/trust-data.ts";
import { CastAuthError } from "../../src/client/errors.ts";
import { encodeAuthError, encodeAuthResponse, HashAlgorithm } from "../../src/protocol/device-auth.ts";
import { PayloadType } from "../../src/protocol/cast-message.ts";
import {
  EXT,
  makeCert,
  makeCrlBundle,
  newKey,
  OID_AUDIO_ONLY,
  OID_CLIENT_AUTH,
  OID_SERVER_AUTH,
  spkiOf,
  type KeyPair,
} from "./pki.ts";

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const NOW = Date.now();
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest();

// Keys are generated once; nothing here is, or derives from, a real device or CA key.
const rootKey = newKey();
const interKey = newKey();
const deviceKey = newKey();
const tlsKey = newKey();
const otherRootKey = newKey();
const crlRootKey = newKey();
const crlSignerKey = newKey();

const long = { notBefore: NOW - 3 * 365 * DAY, notAfter: NOW + 3 * 365 * DAY };
const rootCert = (key: KeyPair, cn = "Test Root") =>
  makeCert({ subject: cn, key, ...long, extensions: [EXT.basicConstraints(true), EXT.keyUsage(5)] });
const interCert = (extra: Buffer[] = []) =>
  makeCert({
    subject: "Test Intermediate",
    issuer: "Test Root",
    key: interKey,
    signer: rootKey,
    serial: 10,
    ...long,
    extensions: [EXT.basicConstraints(true, 0), EXT.keyUsage(5), ...extra],
  });
function deviceCert(opts: { notBefore?: number; notAfter?: number; extensions?: Buffer[]; serial?: number } = {}): Buffer {
  return makeCert({
    subject: "device-1234",
    issuer: "Test Intermediate",
    key: deviceKey,
    signer: interKey,
    serial: opts.serial ?? 4242,
    notBefore: opts.notBefore ?? NOW - 10 * DAY,
    notAfter: opts.notAfter ?? NOW + 300 * DAY,
    extensions: opts.extensions ?? [EXT.keyUsage(0)],
  });
}
const tlsCert = (notAfter = NOW + 2 * DAY) =>
  makeCert({ subject: "tls-device", key: tlsKey, notBefore: NOW - HOUR, notAfter });

const crlRootCert = rootCert(crlRootKey, "Test CRL Root");
const crlSignerCert = makeCert({
  subject: "Test CRL Signer",
  issuer: "Test CRL Root",
  key: crlSignerKey,
  signer: crlRootKey,
  serial: 7,
  // Valid at the instant Chromium checks the fallback CRL's signer (August 2023) and now.
  notBefore: Date.UTC(2020, 0, 1),
  notAfter: NOW + 3 * 365 * DAY,
  extensions: [EXT.basicConstraints(false), EXT.keyUsage(0)],
});
const crlBundle = (spec: Partial<Parameters<typeof makeCrlBundle>[0]> = {}) =>
  makeCrlBundle({
    signerCert: crlSignerCert,
    signerKey: crlSignerKey,
    notBeforeSeconds: Math.floor((NOW - DAY) / 1000),
    notAfterSeconds: Math.floor((NOW + 7 * DAY) / 1000),
    ...spec,
  });

const goodOptions = (over: DeviceAuthOptions = {}): DeviceAuthOptions => ({
  now: NOW,
  roots: [rootCert(rootKey)],
  crlRoots: [crlRootCert],
  fallbackCrl: crlBundle(),
  fallbackCrlBuildTime: NOW,
  ...over,
});

const nonce = Buffer.alloc(16, 7);

interface ReplyOptions {
  device?: Buffer;
  intermediates?: Buffer[];
  signKey?: KeyPair;
  signedTls?: Buffer;
  hash?: "sha1" | "sha256";
  echoNonce?: Buffer | undefined;
  crl?: Buffer;
  flip?: boolean;
}

function reply(tls: Buffer, opts: ReplyOptions = {}) {
  const echoed = "echoNonce" in opts ? opts.echoNonce : nonce;
  const hash = opts.hash ?? "sha256";
  const signed = Buffer.concat([echoed ?? Buffer.alloc(0), opts.signedTls ?? tls]);
  let signature = createSign(hash).update(signed).sign((opts.signKey ?? deviceKey).privateKey);
  if (opts.flip) signature = Buffer.from(signature.map((b, i) => (i === 5 ? b ^ 1 : b)));
  return {
    payloadType: PayloadType.BINARY,
    payloadBinary: encodeAuthResponse({
      signature,
      clientAuthCertificate: opts.device ?? deviceCert(),
      intermediateCertificates: opts.intermediates ?? [interCert()],
      senderNonce: echoed,
      hashAlgorithm: hash === "sha1" ? HashAlgorithm.SHA1 : HashAlgorithm.SHA256,
      crl: opts.crl,
    }),
  };
}

function rejection(fn: () => unknown): CastAuthError {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof CastAuthError, `expected CastAuthError, got ${String(err)}`);
    return err;
  }
  assert.fail("expected authentication to fail");
}

test("embedded roots are the Cast, Eureka and CRL roots from Chromium", () => {
  const fp = (b64: string) => createHash("sha256").update(Buffer.from(b64, "base64")).digest("hex");
  assert.equal(fp(CAST_ROOT_CA_B64), "809af14700b3fe2611ad597eb1584d6354313b64ccdb3390f097fa3e5826d6ca");
  assert.equal(fp(EUREKA_ROOT_CA_B64), "caf6d1e37b532203e01a76bf07187bb731ccd38801565ab2211a2c0ab7f3bc46");
  assert.equal(fp(CAST_CRL_ROOT_CA_B64), "8b77c60291f9d62764613083f49750b1c5caac2d9efbe5a28edf301f9d84831d");
});

test("a good chain and signature authenticate, on the fallback CRL when the device sends none", () => {
  const tls = tlsCert();
  const result = authenticateChallengeReply(reply(tls), tls, nonce, goodOptions());
  assert.deepEqual(result, { policy: "unrestricted", hashAlgorithm: "sha256", nonceEchoed: true, usedFallbackCrl: true });
});

test("a SHA-1 signature is accepted, as Chromium does", () => {
  const tls = tlsCert();
  const result = authenticateChallengeReply(reply(tls, { hash: "sha1" }), tls, nonce, goodOptions());
  assert.equal(result.hashAlgorithm, "sha1");
});

test("a device-supplied CRL that verifies is used instead of the fallback", () => {
  const tls = tlsCert();
  const result = authenticateChallengeReply(reply(tls, { crl: crlBundle() }), tls, nonce, goodOptions());
  assert.equal(result.usedFallbackCrl, false);
});

test("a nonce that is not echoed is tolerated and reported", () => {
  const tls = tlsCert();
  const result = authenticateChallengeReply(reply(tls, { echoNonce: Buffer.alloc(16, 9) }), tls, nonce, goodOptions());
  assert.equal(result.nonceEchoed, false);
});

test("a chain that ends at a different root is untrusted", () => {
  const tls = tlsCert();
  const err = rejection(() => authenticateChallengeReply(reply(tls), tls, nonce, goodOptions({ roots: [rootCert(otherRootKey)] })));
  assert.equal(err.reason, "untrusted_chain");
});

test("a missing intermediate is untrusted", () => {
  const tls = tlsCert();
  const err = rejection(() => authenticateChallengeReply(reply(tls, { intermediates: [] }), tls, nonce, goodOptions()));
  assert.equal(err.reason, "untrusted_chain");
});

test("an expired device certificate is rejected", () => {
  const tls = tlsCert();
  const device = deviceCert({ notBefore: NOW - 20 * DAY, notAfter: NOW - DAY });
  const err = rejection(() => authenticateChallengeReply(reply(tls, { device }), tls, nonce, goodOptions()));
  assert.equal(err.reason, "invalid_certificate");
  assert.match(err.message, /expired/);
});

test("a device certificate that is not yet valid is rejected", () => {
  const tls = tlsCert();
  const device = deviceCert({ notBefore: NOW + DAY, notAfter: NOW + 20 * DAY });
  const err = rejection(() => authenticateChallengeReply(reply(tls, { device }), tls, nonce, goodOptions()));
  assert.equal(err.reason, "invalid_certificate");
});

test("a tampered signature is rejected", () => {
  const tls = tlsCert();
  const err = rejection(() => authenticateChallengeReply(reply(tls, { flip: true }), tls, nonce, goodOptions()));
  assert.equal(err.reason, "bad_signature");
});

test("a signature by a key that is not the certificate's is rejected", () => {
  const tls = tlsCert();
  const err = rejection(() => authenticateChallengeReply(reply(tls, { signKey: otherRootKey }), tls, nonce, goodOptions()));
  assert.equal(err.reason, "bad_signature");
});

test("a signature over a different TLS certificate is rejected (a relayed proof)", () => {
  const tls = tlsCert();
  const relayed = makeCert({ subject: "someone-else", key: tlsKey, notBefore: NOW - HOUR, notAfter: NOW + DAY });
  const err = rejection(() => authenticateChallengeReply(reply(tls, { signedTls: relayed }), tls, nonce, goodOptions()));
  assert.equal(err.reason, "bad_signature");
});

test("an auth error reply is rejected", () => {
  const tls = tlsCert();
  const err = rejection(() =>
    authenticateChallengeReply({ payloadType: PayloadType.BINARY, payloadBinary: encodeAuthError(1) }, tls, nonce, goodOptions()),
  );
  assert.equal(err.reason, "device_error");
});

test("malformed replies are rejected", () => {
  const tls = tlsCert();
  const garbage = { payloadType: PayloadType.BINARY, payloadBinary: Buffer.from([0x12, 0xff, 0xff, 0x01]) };
  assert.equal(rejection(() => authenticateChallengeReply(garbage, tls, nonce, goodOptions())).reason, "malformed_reply");
  const text = { payloadType: PayloadType.STRING, payloadBinary: undefined };
  assert.equal(rejection(() => authenticateChallengeReply(text, tls, nonce, goodOptions())).reason, "malformed_reply");
  const empty = { payloadType: PayloadType.BINARY, payloadBinary: Buffer.alloc(0) };
  assert.equal(rejection(() => authenticateChallengeReply(empty, tls, nonce, goodOptions())).reason, "malformed_reply");
});

test("a TLS certificate that outlives the signature window is rejected", () => {
  const tls = tlsCert(NOW + 30 * DAY);
  const err = rejection(() => authenticateChallengeReply(reply(tls), tls, nonce, goodOptions()));
  assert.equal(err.reason, "tls_certificate_invalid");
});

test("an expired TLS certificate is rejected", () => {
  const tls = tlsCert(NOW - HOUR / 2);
  const err = rejection(() => authenticateChallengeReply(reply(tls), tls, nonce, goodOptions()));
  assert.equal(err.reason, "tls_certificate_invalid");
});

test("an audio-only policy anywhere in the path restricts the device", () => {
  const tls = tlsCert();
  const result = authenticateChallengeReply(
    reply(tls, { intermediates: [interCert([EXT.policies(OID_AUDIO_ONLY)])], device: deviceCert({ extensions: [EXT.keyUsage(0), EXT.policies(OID_AUDIO_ONLY)] }) }),
    tls,
    nonce,
    goodOptions(),
  );
  assert.equal(result.policy, "audio_only");
});

test("the device certificate needs digitalSignature key usage", () => {
  const tls = tlsCert();
  const device = deviceCert({ extensions: [EXT.keyUsage(5)] });
  const err = rejection(() => authenticateChallengeReply(reply(tls, { device }), tls, nonce, goodOptions()));
  assert.equal(err.reason, "invalid_certificate");
});

test("extended key usage must allow clientAuth", () => {
  const tls = tlsCert();
  const bad = deviceCert({ extensions: [EXT.keyUsage(0), EXT.eku(OID_SERVER_AUTH)] });
  assert.equal(rejection(() => authenticateChallengeReply(reply(tls, { device: bad }), tls, nonce, goodOptions())).reason, "untrusted_chain");
  const good = deviceCert({ extensions: [EXT.keyUsage(0), EXT.eku(OID_CLIENT_AUTH)] });
  authenticateChallengeReply(reply(tls, { device: good }), tls, nonce, goodOptions());
});

test("an unrecognized critical extension fails the chain", () => {
  const tls = tlsCert();
  const device = deviceCert({ extensions: [EXT.keyUsage(0), EXT.unknownCritical()] });
  const err = rejection(() => authenticateChallengeReply(reply(tls, { device }), tls, nonce, goodOptions()));
  assert.equal(err.reason, "untrusted_chain");
});

test("the intermediate's path length constraint is enforced", () => {
  const tls = tlsCert();
  // A leaf signed by a CA below a pathLen:0 intermediate has one CA too many.
  const subKey = newKey();
  const subCert = makeCert({ subject: "Sub CA", issuer: "Test Intermediate", key: subKey, signer: interKey, serial: 12, ...long, extensions: [EXT.basicConstraints(true), EXT.keyUsage(5)] });
  const leaf = makeCert({ subject: "device-1234", issuer: "Sub CA", key: deviceKey, signer: subKey, serial: 13, notBefore: NOW - DAY, notAfter: NOW + 100 * DAY, extensions: [EXT.keyUsage(0)] });
  const err = rejection(() => authenticateChallengeReply(reply(tls, { device: leaf, intermediates: [subCert, interCert()] }), tls, nonce, goodOptions()));
  assert.equal(err.reason, "untrusted_chain");
});

test("name constraints on an intermediate are enforced", () => {
  const tls = tlsCert();
  const constrained = interCert([EXT.permitDns("example.test")]);
  const inside = deviceCert({ extensions: [EXT.keyUsage(0), EXT.san("a.example.test")] });
  authenticateChallengeReply(reply(tls, { intermediates: [constrained], device: inside }), tls, nonce, goodOptions());
  const outside = deviceCert({ extensions: [EXT.keyUsage(0), EXT.san("a.other.test")] });
  const err = rejection(() => authenticateChallengeReply(reply(tls, { intermediates: [constrained], device: outside }), tls, nonce, goodOptions()));
  assert.equal(err.reason, "untrusted_chain");
});

test("the real fallback CRL verifies against the real Cast CRL root", () => {
  const roots = [Buffer.from(CAST_CRL_ROOT_CA_B64, "base64")].map((d) => parseCertificate(d));
  const fallback = parseAndVerifyCrl(Buffer.from(CAST_FALLBACK_CRL_B64, "base64"), NOW, { anchors: roots, isFallback: true, fallbackBuildTime: NOW });
  assert.ok(fallback !== undefined);
  assert.equal(parseAndVerifyCrl(Buffer.from(CAST_FALLBACK_CRL_B64, "base64"), NOW, { anchors: roots, isFallback: true, fallbackBuildTime: NOW - 21 * 7 * DAY }), undefined);
});

test("revocation by public key hash in the device's CRL is rejected", () => {
  const tls = tlsCert();
  const crl = crlBundle({ revokedPublicKeyHashes: [sha256(spkiOf(deviceKey.publicKey))] });
  const err = rejection(() => authenticateChallengeReply(reply(tls, { crl }), tls, nonce, goodOptions()));
  assert.equal(err.reason, "revoked");
});

test("revocation by serial number range under the issuer is rejected", () => {
  const tls = tlsCert();
  const crl = crlBundle({ serialRanges: [{ issuerPublicKeyHash: sha256(spkiOf(interKey.publicKey)), first: 4000, last: 5000 }] });
  const err = rejection(() => authenticateChallengeReply(reply(tls, { crl }), tls, nonce, goodOptions()));
  assert.equal(err.reason, "revoked");
  const outside = crlBundle({ serialRanges: [{ issuerPublicKeyHash: sha256(spkiOf(interKey.publicKey)), first: 1, last: 100 }] });
  authenticateChallengeReply(reply(tls, { crl: outside }), tls, nonce, goodOptions());
});

test("revocation by the fallback CRL is rejected", () => {
  const tls = tlsCert();
  const fallbackCrl = crlBundle({ revokedPublicKeyHashes: [sha256(spkiOf(interKey.publicKey))] });
  const err = rejection(() => authenticateChallengeReply(reply(tls), tls, nonce, goodOptions({ fallbackCrl })));
  assert.equal(err.reason, "revoked");
});

test("without a valid CRL from the device or a valid fallback CRL the device is refused", () => {
  const tls = tlsCert();
  assert.equal(rejection(() => authenticateChallengeReply(reply(tls), tls, nonce, goodOptions({ fallbackCrl: null }))).reason, "crl_invalid");
  // The fallback CRL is valid for 20 weeks from its build time.
  const stale = goodOptions({ fallbackCrlBuildTime: NOW - 21 * 7 * DAY });
  assert.equal(rejection(() => authenticateChallengeReply(reply(tls), tls, nonce, stale)).reason, "crl_invalid");
  // A device-supplied CRL still carries a device whose fallback CRL is gone.
  authenticateChallengeReply(reply(tls, { crl: crlBundle() }), tls, nonce, stale);
});

test("a CRL signed by an untrusted signer is not used", () => {
  const tls = tlsCert();
  const err = rejection(() =>
    authenticateChallengeReply(reply(tls, { crl: crlBundle() }), tls, nonce, goodOptions({ crlRoots: [rootCert(otherRootKey, "Other CRL Root")], fallbackCrl: null })),
  );
  assert.equal(err.reason, "crl_invalid");
});

test("a CRL outside its validity window is not used", () => {
  const tls = tlsCert();
  const old = crlBundle({ notBeforeSeconds: Math.floor((NOW - 10 * DAY) / 1000), notAfterSeconds: Math.floor((NOW - DAY) / 1000) });
  const err = rejection(() => authenticateChallengeReply(reply(tls, { crl: old }), tls, nonce, goodOptions({ fallbackCrl: null })));
  assert.equal(err.reason, "crl_invalid");
});
