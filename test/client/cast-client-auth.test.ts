import assert from "node:assert/strict";
import { createSign } from "node:crypto";
import { afterEach, test } from "node:test";
import { CastAuthError, CastClient, NS } from "../../src/client/index.ts";
import type { CastClientOptions } from "../../src/client/index.ts";
import { encodeAuthError, encodeAuthResponse, HashAlgorithm } from "../../src/protocol/device-auth.ts";
import { FakeReceiver, type Received } from "./fake-receiver.ts";
import { EXT, makeCert, makeCrlBundle, newKey, toPem } from "./pki.ts";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();

const rootKey = newKey();
const interKey = newKey();
const deviceKey = newKey();
const tlsKey = newKey();
const crlRootKey = newKey();
const crlSignerKey = newKey();
const long = { notBefore: NOW - 3 * 365 * DAY, notAfter: NOW + 3 * 365 * DAY };

const rootDer = makeCert({ subject: "Test Root", key: rootKey, ...long, extensions: [EXT.basicConstraints(true), EXT.keyUsage(5)] });
const interDer = makeCert({
  subject: "Test Intermediate",
  issuer: "Test Root",
  key: interKey,
  signer: rootKey,
  ...long,
  extensions: [EXT.basicConstraints(true, 0), EXT.keyUsage(5)],
});
const deviceDer = makeCert({
  subject: "device-1",
  issuer: "Test Intermediate",
  key: deviceKey,
  signer: interKey,
  notBefore: NOW - DAY,
  notAfter: NOW + 100 * DAY,
  extensions: [EXT.keyUsage(0)],
});
const crlRootDer = makeCert({ subject: "Test CRL Root", key: crlRootKey, ...long, extensions: [EXT.basicConstraints(true), EXT.keyUsage(5)] });
const crlSignerDer = makeCert({
  subject: "Test CRL Signer",
  issuer: "Test CRL Root",
  key: crlSignerKey,
  signer: crlRootKey,
  notBefore: Date.UTC(2020, 0, 1),
  notAfter: NOW + 3 * 365 * DAY,
  extensions: [EXT.basicConstraints(false), EXT.keyUsage(0)],
});
const tlsDer = makeCert({ subject: "tls-device", key: tlsKey, notBefore: NOW - 3600_000, notAfter: NOW + 2 * DAY });

const credentials = { key: tlsKey.privateKey.export({ type: "pkcs8", format: "pem" }), cert: toPem(tlsDer) };

const deviceAuth = {
  roots: [rootDer],
  crlRoots: [crlRootDer],
  fallbackCrl: makeCrlBundle({
    signerCert: crlSignerDer,
    signerKey: crlSignerKey,
    notBeforeSeconds: Math.floor((NOW - DAY) / 1000),
    notAfterSeconds: Math.floor((NOW + 7 * DAY) / 1000),
  }),
  fallbackCrlBuildTime: NOW,
};

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

/** The nonce of the AuthChallenge the client sent: DeviceAuthMessage.challenge.sender_nonce. */
function challengeNonce(msg: Received): Buffer {
  const bin = msg.payloadBinary as Buffer;
  assert.equal(bin[0], 0x0a);
  const inner = bin.subarray(2, 2 + (bin[1] as number));
  assert.equal(inner[0], 0x12);
  return inner.subarray(2, 2 + (inner[1] as number));
}

type Responder = (nonce: Buffer, signed: Buffer) => Buffer | undefined;

function goodResponse(nonce: Buffer, signedTls = tlsDer): Buffer {
  const signature = createSign("sha256").update(Buffer.concat([nonce, signedTls])).sign(deviceKey.privateKey);
  return encodeAuthResponse({
    signature,
    clientAuthCertificate: deviceDer,
    intermediateCertificates: [interDer],
    senderNonce: nonce,
    hashAlgorithm: HashAlgorithm.SHA256,
  });
}

async function setup(respond: Responder | null, opts: Partial<CastClientOptions> = {}) {
  const fake = new FakeReceiver(credentials);
  fake.onMessage = (msg) => {
    if (msg.namespace !== NS.DEVICE_AUTH) return;
    if (respond !== null) {
      const payload = respond(challengeNonce(msg), tlsDer);
      if (payload !== undefined) fake.send({ namespace: NS.DEVICE_AUTH, sourceId: "receiver-0", destinationId: msg.sourceId, payloadType: 1, payloadBinary: payload });
    }
    return true;
  };
  const port = await fake.listen();
  const client = new CastClient({ host: "127.0.0.1", port, deviceAuth, authTimeoutMs: 300, ...opts });
  cleanups.push(() => fake.close(), () => client.close());
  return { fake, client };
}

async function rejects(client: CastClient): Promise<CastAuthError> {
  try {
    await client.connect();
  } catch (err) {
    assert.ok(err instanceof CastAuthError, `expected CastAuthError, got ${String(err)}`);
    assert.equal(client.connected, false);
    return err;
  }
  assert.fail("connect should have been rejected");
}

test("a device that proves itself is connected and the result is exposed", async () => {
  const { fake, client } = await setup((nonce) => goodResponse(nonce));
  await client.connect();
  assert.equal(client.connected, true);
  assert.equal(client.deviceAuth?.policy, "unrestricted");
  const challenge = fake.received.find((m) => m.namespace === NS.DEVICE_AUTH);
  assert.equal(challenge?.sourceId, "sender-0");
  assert.equal(challenge?.destinationId, "receiver-0");
  assert.equal(challengeNonce(challenge as Received).length, 16);
  await fake.ready();
});

test("CONNECT is not sent before the device has proved itself", async () => {
  const { fake, client } = await setup(() => undefined);
  await rejects(client);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(fake.received.some((m) => m.namespace === NS.CONNECTION), false);
});

test("a device that never answers times out with reason timeout and the socket is closed", async () => {
  const { fake, client } = await setup(() => undefined);
  const err = await rejects(client);
  assert.equal(err.reason, "timeout");
  assert.equal(err.host, "127.0.0.1");
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(fake.connections, 1);
});

test("an untrusted chain is refused", async () => {
  const { client } = await setup((nonce) => goodResponse(nonce), { deviceAuth: { ...deviceAuth, roots: [crlRootDer] } });
  assert.equal((await rejects(client)).reason, "untrusted_chain");
});

test("a signature over a different TLS certificate is refused", async () => {
  const other = makeCert({ subject: "other", key: tlsKey, notBefore: NOW - 3600_000, notAfter: NOW + DAY });
  const { client } = await setup((nonce) => goodResponse(nonce, other));
  assert.equal((await rejects(client)).reason, "bad_signature");
});

test("an error reply is refused", async () => {
  const { client } = await setup(() => encodeAuthError(1));
  assert.equal((await rejects(client)).reason, "device_error");
});

test("a malformed reply is refused", async () => {
  const { client } = await setup(() => Buffer.from([0x12, 0xff, 0xff, 0x01]));
  assert.equal((await rejects(client)).reason, "malformed_reply");
});

test("verification is on by default: a device with the stock test certificate and no proof is refused", async () => {
  const fake = new FakeReceiver();
  const port = await fake.listen();
  const client = new CastClient({ host: "127.0.0.1", port, authTimeoutMs: 200 });
  cleanups.push(() => fake.close(), () => client.close());
  assert.equal((await rejects(client)).reason, "timeout");
});

test("verifyDevice false connects without challenging the device", async () => {
  const fake = new FakeReceiver();
  const port = await fake.listen();
  const client = new CastClient({ host: "127.0.0.1", port, verifyDevice: false });
  cleanups.push(() => fake.close(), () => client.close());
  await client.connect();
  await fake.ready();
  assert.equal(fake.received.some((m) => m.namespace === NS.DEVICE_AUTH), false);
  assert.equal(client.deviceAuth, undefined);
});
