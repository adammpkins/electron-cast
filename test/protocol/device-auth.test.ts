import assert from "node:assert/strict";
import { test } from "node:test";
import { CastProtocolError, decodeDeviceAuthMessage, encodeAuthChallenge, encodeAuthError, encodeAuthResponse, HashAlgorithm } from "../../src/protocol/index.ts";

test("an AuthChallenge is DeviceAuthMessage field 1 with the nonce and hash algorithm", () => {
  const nonce = Buffer.alloc(16, 1);
  const bytes = encodeAuthChallenge({ senderNonce: nonce, hashAlgorithm: HashAlgorithm.SHA256 });
  assert.deepEqual([...bytes], [0x0a, 20, 0x12, 16, ...nonce, 0x18, 1]);
});

test("an AuthResponse round trips with its optional fields", () => {
  const bytes = encodeAuthResponse({
    signature: Buffer.from("sig"),
    clientAuthCertificate: Buffer.from("cert"),
    intermediateCertificates: [Buffer.from("i1"), Buffer.from("i2")],
    senderNonce: Buffer.from("nonce"),
    hashAlgorithm: HashAlgorithm.SHA256,
    crl: Buffer.from("crl"),
  });
  const { response } = decodeDeviceAuthMessage(bytes);
  assert.equal(response?.signature.toString(), "sig");
  assert.equal(response?.clientAuthCertificate.toString(), "cert");
  assert.deepEqual(response?.intermediateCertificates.map(String), ["i1", "i2"]);
  assert.equal(response?.senderNonce.toString(), "nonce");
  assert.equal(response?.hashAlgorithm, HashAlgorithm.SHA256);
  assert.equal(response?.crl?.toString(), "crl");
});

test("an AuthResponse without a hash algorithm defaults to SHA-1, as the proto does", () => {
  const bytes = encodeAuthResponse({ signature: Buffer.from("s"), clientAuthCertificate: Buffer.from("c") });
  assert.equal(decodeDeviceAuthMessage(bytes).response?.hashAlgorithm, HashAlgorithm.SHA1);
});

test("an AuthError decodes", () => {
  assert.equal(decodeDeviceAuthMessage(encodeAuthError(2)).error?.errorType, 2);
});

test("a response missing its signature or certificate is a protocol error", () => {
  assert.throws(() => decodeDeviceAuthMessage(Buffer.from([0x12, 0])), CastProtocolError);
  assert.throws(() => decodeDeviceAuthMessage(Buffer.from([0x12, 0xff, 0xff, 0x01])), CastProtocolError);
});

test("unknown fields are skipped", () => {
  const known = encodeAuthError(1);
  const bytes = Buffer.concat([Buffer.from([0x38, 0x05]), known]);
  assert.equal(decodeDeviceAuthMessage(bytes).error?.errorType, 1);
});
