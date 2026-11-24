import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeCastMessage, decodeCastMessage, PayloadType, type CastMessage } from "../../src/protocol/cast-message.ts";
import { CastProtocolError } from "../../src/protocol/errors.ts";

const HEARTBEAT = "urn:x-cast:com.google.cast.tp.heartbeat";

function str(tag: number, value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  assert.ok(bytes.length < 128, "helper only handles one-byte lengths");
  return Buffer.concat([Buffer.from([tag, bytes.length]), bytes]);
}

function ping(): CastMessage {
  return {
    protocolVersion: 0,
    sourceId: "sender-0",
    destinationId: "receiver-0",
    namespace: HEARTBEAT,
    payloadType: PayloadType.STRING,
    payloadUtf8: '{"type":"PING"}',
  };
}

const PING_BYTES = Buffer.concat([
  Buffer.from([0x08, 0x00]),
  str(0x12, "sender-0"),
  str(0x1a, "receiver-0"),
  str(0x22, HEARTBEAT),
  Buffer.from([0x28, 0x00]),
  str(0x32, '{"type":"PING"}'),
]);

test("PayloadType values", () => {
  assert.equal(PayloadType.STRING, 0);
  assert.equal(PayloadType.BINARY, 1);
});

test("encodes a string message byte-for-byte in field order", () => {
  const out = encodeCastMessage(ping());
  assert.ok(Buffer.isBuffer(out));
  assert.equal(out.toString("hex"), PING_BYTES.toString("hex"));
});

test("decodes a string message", () => {
  const msg = decodeCastMessage(PING_BYTES);
  assert.deepEqual(msg, ping());
});

test("round-trips multi-byte UTF-8 and reports byte length, not char length", () => {
  const msg = { ...ping(), payloadUtf8: '{"text":"héllo ✓ 🎵"}' };
  const bytes = encodeCastMessage(msg);
  const payload = Buffer.from(msg.payloadUtf8, "utf8");
  const tail = bytes.subarray(bytes.length - payload.length - 2);
  assert.equal(tail[0], 0x32);
  assert.equal(tail[1], payload.length);
  assert.deepEqual(decodeCastMessage(bytes), msg);
});

test("uses multi-byte varint lengths for payloads of 128 bytes or more", () => {
  const payloadUtf8 = "x".repeat(300); // 300 = varint 0xAC 0x02
  const bytes = encodeCastMessage({ ...ping(), payloadUtf8 });
  const idx = bytes.length - 300 - 3;
  assert.deepEqual([...bytes.subarray(idx, idx + 3)], [0x32, 0xac, 0x02]);
  assert.equal(decodeCastMessage(bytes).payloadUtf8, payloadUtf8);
});

test("round-trips a binary payload and omits payload_utf8", () => {
  const msg: CastMessage = {
    protocolVersion: 0,
    sourceId: "sender-1",
    destinationId: "receiver-0",
    namespace: "urn:x-cast:com.google.cast.tp.deviceauth",
    payloadType: PayloadType.BINARY,
    payloadBinary: Buffer.from([0x00, 0x01, 0x02, 0xff]),
  };
  const bytes = encodeCastMessage(msg);
  assert.ok(!bytes.includes(0x32), "no payload_utf8 tag expected");
  assert.equal(bytes.subarray(-6).toString("hex"), "3a04000102ff");
  const back = decodeCastMessage(bytes);
  assert.equal(back.payloadType, PayloadType.BINARY);
  assert.ok(Buffer.isBuffer(back.payloadBinary));
  assert.equal(back.payloadBinary?.toString("hex"), "000102ff");
  assert.equal(back.payloadUtf8, undefined);
  assert.ok(!("payloadUtf8" in back), "absent optional fields are not set as keys");
});

test("writes required empty strings", () => {
  const bytes = encodeCastMessage({ ...ping(), sourceId: "", payloadUtf8: undefined });
  assert.equal(bytes.subarray(2, 4).toString("hex"), "1200");
  const back = decodeCastMessage(bytes);
  assert.equal(back.sourceId, "");
  assert.ok(!("payloadUtf8" in back));
});

test("accepts a plain Uint8Array for decoding", () => {
  assert.deepEqual(decodeCastMessage(new Uint8Array(PING_BYTES)), ping());
});

test("skips unknown fields of every wire type", () => {
  const extra = Buffer.from([
    0x40, 0x01, // field 8 varint (continued = true)
    0x48, 0xac, 0x02, // field 9 varint 300
    0x51, 1, 2, 3, 4, 5, 6, 7, 8, // field 10 fixed64
    0x5d, 1, 2, 3, 4, // field 11 fixed32
    0x7a, 0x03, 0x61, 0x62, 0x63, // field 15 length-delimited "abc"
  ]);
  assert.deepEqual(decodeCastMessage(Buffer.concat([PING_BYTES, extra])), ping());
  assert.deepEqual(decodeCastMessage(Buffer.concat([extra, PING_BYTES])), ping());
});

test("last occurrence of a repeated scalar field wins", () => {
  const bytes = Buffer.concat([PING_BYTES, str(0x12, "sender-9")]);
  assert.equal(decodeCastMessage(bytes).sourceId, "sender-9");
});

test("rejects a missing required field", () => {
  const noNamespace = Buffer.concat([
    Buffer.from([0x08, 0x00]),
    str(0x12, "sender-0"),
    str(0x1a, "receiver-0"),
    Buffer.from([0x28, 0x00]),
  ]);
  assert.throws(() => decodeCastMessage(noNamespace), CastProtocolError);
  const noPayloadType = Buffer.concat([
    Buffer.from([0x08, 0x00]),
    str(0x12, "sender-0"),
    str(0x1a, "receiver-0"),
    str(0x22, HEARTBEAT),
  ]);
  assert.throws(() => decodeCastMessage(noPayloadType), CastProtocolError);
});

test("rejects truncated input", () => {
  // Dropping the whole optional payload_utf8 field leaves a valid message; every other cut is malformed.
  const payloadFieldLength = str(0x32, '{"type":"PING"}').length;
  for (let cut = 1; cut < PING_BYTES.length; cut++) {
    const partial = PING_BYTES.subarray(0, PING_BYTES.length - cut);
    if (cut === payloadFieldLength) {
      const { payloadUtf8: _dropped, ...rest } = ping();
      assert.deepEqual(decodeCastMessage(partial), rest);
      continue;
    }
    assert.throws(() => decodeCastMessage(partial), CastProtocolError, `cut ${cut}`);
  }
});

test("rejects a length that runs past the end of the buffer", () => {
  const bad = Buffer.concat([Buffer.from([0x08, 0x00, 0x12, 0x7f]), Buffer.from("short")]);
  assert.throws(() => decodeCastMessage(bad), CastProtocolError);
});

test("rejects a known field with the wrong wire type", () => {
  // field 4 (namespace) sent as varint (tag 0x20) instead of length-delimited
  const bad = Buffer.concat([
    Buffer.from([0x08, 0x00]),
    str(0x12, "sender-0"),
    str(0x1a, "receiver-0"),
    Buffer.from([0x20, 0x05]),
    Buffer.from([0x28, 0x00]),
  ]);
  assert.throws(() => decodeCastMessage(bad), CastProtocolError);
});

test("rejects unsupported wire types 3 and 4 (groups) and 6, 7", () => {
  for (const tag of [0x7b, 0x7c, 0x7e, 0x7f]) {
    assert.throws(() => decodeCastMessage(Buffer.concat([PING_BYTES, Buffer.from([tag, 0x00])])), CastProtocolError);
  }
});

test("rejects an unknown payload_type and a non-zero protocol_version", () => {
  const badType = Buffer.from(PING_BYTES);
  const typeIdx = badType.indexOf(Buffer.from([0x28, 0x00]));
  badType[typeIdx + 1] = 0x02;
  assert.throws(() => decodeCastMessage(badType), CastProtocolError);
  const badVersion = Buffer.from(PING_BYTES);
  badVersion[1] = 0x07;
  assert.throws(() => decodeCastMessage(badVersion), CastProtocolError);
});

test("rejects a varint longer than 10 bytes", () => {
  const bad = Buffer.concat([PING_BYTES, Buffer.from([0x40, ...new Array(11).fill(0xff), 0x01])]);
  assert.throws(() => decodeCastMessage(bad), CastProtocolError);
});

test("encode validates its input", () => {
  assert.throws(() => encodeCastMessage({ ...ping(), payloadType: 2 as 0 }), TypeError);
  assert.throws(() => encodeCastMessage({ ...ping(), payloadType: PayloadType.STRING, payloadUtf8: undefined, payloadBinary: Buffer.from([1]) }), TypeError);
  assert.throws(() => encodeCastMessage({ ...ping(), payloadType: PayloadType.BINARY, payloadUtf8: "x" }), TypeError);
});

test("CastProtocolError is an Error with its own name", () => {
  const err = new CastProtocolError("boom");
  assert.ok(err instanceof Error);
  assert.equal(err.name, "CastProtocolError");
  assert.equal(err.message, "boom");
});
