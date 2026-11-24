import { test } from "node:test";
import assert from "node:assert/strict";
import { frame, FrameDecoder, MAX_MESSAGE_SIZE } from "../../src/protocol/framing.ts";
import { CastProtocolError } from "../../src/protocol/errors.ts";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

test("MAX_MESSAGE_SIZE is 65536", () => {
  assert.equal(MAX_MESSAGE_SIZE, 65536);
});

test("frame prefixes a 4-byte big-endian length", () => {
  const out = frame(Buffer.from("abc"));
  assert.ok(Buffer.isBuffer(out));
  assert.equal(hex(out), "00000003616263");
  assert.equal(hex(frame(new Uint8Array(300))).slice(0, 8), "0000012c");
});

test("frame accepts exactly the maximum and rejects one byte more", () => {
  assert.equal(frame(new Uint8Array(MAX_MESSAGE_SIZE)).length, MAX_MESSAGE_SIZE + 4);
  assert.throws(() => frame(new Uint8Array(MAX_MESSAGE_SIZE + 1)), RangeError);
});

test("decoder returns several bodies from one chunk", () => {
  const d = new FrameDecoder();
  const out = d.push(Buffer.concat([frame(Buffer.from("one")), frame(Buffer.from("two")), frame(Buffer.from("three"))]));
  assert.deepEqual(out.map((b) => b.toString()), ["one", "two", "three"]);
  for (const b of out) assert.ok(Buffer.isBuffer(b));
});

test("decoder reassembles a stream fed one byte at a time", () => {
  const d = new FrameDecoder();
  const stream = Buffer.concat([frame(Buffer.from("hello")), frame(Buffer.from("world"))]);
  const got: string[] = [];
  for (const byte of stream) {
    for (const body of d.push(Buffer.from([byte]))) got.push(body.toString());
  }
  assert.deepEqual(got, ["hello", "world"]);
});

test("decoder handles a header split across chunks and a trailing partial frame", () => {
  const d = new FrameDecoder();
  const a = frame(Buffer.from("first"));
  const b = frame(Buffer.from("second"));
  assert.deepEqual(d.push(a.subarray(0, 2)), []);
  const mid = Buffer.concat([a.subarray(2), b.subarray(0, 6)]);
  assert.deepEqual(d.push(mid).map(String), ["first"]);
  assert.deepEqual(d.push(b.subarray(6)).map(String), ["second"]);
});

test("decoder returns an empty body for a zero-length frame", () => {
  const out = new FrameDecoder().push(Buffer.from([0, 0, 0, 0]));
  assert.equal(out.length, 1);
  assert.equal(out[0]?.length, 0);
});

test("decoder output does not alias later input", () => {
  const d = new FrameDecoder();
  const chunk = Buffer.concat([frame(Buffer.from("keep")), frame(Buffer.from("next")).subarray(0, 3)]);
  const [body] = d.push(chunk);
  chunk.fill(0);
  assert.equal(body?.toString(), "keep");
});

test("decoder rejects a declared length above the maximum, then stays failed", () => {
  const d = new FrameDecoder();
  const header = Buffer.alloc(4);
  header.writeUInt32BE(MAX_MESSAGE_SIZE + 1);
  assert.throws(() => d.push(header), CastProtocolError);
  assert.throws(() => d.push(frame(Buffer.from("ok"))), CastProtocolError);
});

test("decoder accepts a body of exactly the maximum size", () => {
  const out = new FrameDecoder().push(frame(new Uint8Array(MAX_MESSAGE_SIZE)));
  assert.equal(out[0]?.length, MAX_MESSAGE_SIZE);
});

test("bufferedBytes reports the partial frame held", () => {
  const d = new FrameDecoder();
  assert.equal(d.bufferedBytes, 0);
  d.push(frame(Buffer.from("abcdef")).subarray(0, 7));
  assert.equal(d.bufferedBytes, 7);
  d.push(Buffer.from("def"));
  assert.equal(d.bufferedBytes, 0);
});
