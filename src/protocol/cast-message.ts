import { CastProtocolError } from "./errors.ts";

/** Payload kinds for a CastMessage, matching the protobuf enum values. */
export const PayloadType = { STRING: 0, BINARY: 1 } as const;
export type PayloadType = (typeof PayloadType)[keyof typeof PayloadType];

/** A single Google Cast v2 message (cast_channel.proto CastMessage). */
export interface CastMessage {
  protocolVersion: 0;
  sourceId: string;
  destinationId: string;
  namespace: string;
  payloadType: PayloadType;
  payloadUtf8?: string;
  payloadBinary?: Buffer;
}

/** Encode a CastMessage to protobuf wire format, fields in ascending order. */
export function encodeCastMessage(msg: CastMessage): Buffer {
  if (msg.payloadType !== PayloadType.STRING && msg.payloadType !== PayloadType.BINARY) {
    throw new TypeError(`payloadType must be 0 or 1, got ${msg.payloadType}`);
  }
  if (msg.payloadType === PayloadType.STRING && msg.payloadBinary !== undefined) {
    throw new TypeError("payloadBinary must not be set when payloadType is STRING");
  }
  if (msg.payloadType === PayloadType.BINARY && msg.payloadUtf8 !== undefined) {
    throw new TypeError("payloadUtf8 must not be set when payloadType is BINARY");
  }

  const parts: Buffer[] = [];
  const tag = (number: number, wireType: number) => parts.push(Buffer.from([number << 3 | wireType]));
  const varint = (value: number) => {
    const bytes: number[] = [];
    let v = value;
    for (;;) {
      if (v < 0x80) {
        bytes.push(v);
        break;
      }
      bytes.push((v & 0x7f) | 0x80);
      v = Math.floor(v / 128);
    }
    parts.push(Buffer.from(bytes));
  };
  const strField = (number: number, value: string) => {
    tag(number, 2);
    const bytes = Buffer.from(value, "utf8");
    varint(bytes.length);
    parts.push(bytes);
  };

  tag(1, 0);
  varint(msg.protocolVersion);
  strField(2, msg.sourceId);
  strField(3, msg.destinationId);
  strField(4, msg.namespace);
  tag(5, 0);
  varint(msg.payloadType);
  if (msg.payloadUtf8 !== undefined) strField(6, msg.payloadUtf8);
  if (msg.payloadBinary !== undefined) {
    tag(7, 2);
    varint(msg.payloadBinary.length);
    parts.push(msg.payloadBinary);
  }
  return Buffer.concat(parts);
}

interface VarintResult {
  value: number;
  next: number;
}

interface BytesResult {
  value: Uint8Array;
  next: number;
}

function readVarint(bytes: Uint8Array, pos: number): VarintResult {
  let value = 0;
  let weight = 1;
  for (let i = 0; i < 10; i++) {
    const byte = bytes[pos + i];
    if (byte === undefined) throw new CastProtocolError("varint runs past end of input");
    value += (byte & 0x7f) * weight;
    weight *= 128;
    if ((byte & 0x80) === 0) return { value, next: pos + i + 1 };
  }
  throw new CastProtocolError("varint longer than 10 bytes");
}

function readBytes(bytes: Uint8Array, pos: number): BytesResult {
  const length = readVarint(bytes, pos);
  const start = length.next;
  const end = start + length.value;
  if (end > bytes.length) throw new CastProtocolError("length-delimited field runs past end of input");
  return { value: bytes.subarray(start, end), next: end };
}

function skipField(bytes: Uint8Array, pos: number, wireType: number): number {
  switch (wireType) {
    case 0:
      return readVarint(bytes, pos).next;
    case 1:
      return takeFixed(bytes, pos, 8);
    case 2:
      return readBytes(bytes, pos).next;
    case 5:
      return takeFixed(bytes, pos, 4);
    default:
      throw new CastProtocolError(`unsupported wire type ${wireType}`);
  }
}

function takeFixed(bytes: Uint8Array, pos: number, size: number): number {
  if (pos + size > bytes.length) throw new CastProtocolError("truncated fixed-size field");
  return pos + size;
}

/** Decode protobuf wire-format bytes into a CastMessage. */
export function decodeCastMessage(bytes: Uint8Array): CastMessage {
  let pos = 0;
  let protocolVersion: number | undefined;
  let sourceId: string | undefined;
  let destinationId: string | undefined;
  let namespace: string | undefined;
  let payloadType: number | undefined;
  let payloadUtf8: string | undefined;
  let payloadBinary: Buffer | undefined;

  while (pos < bytes.length) {
    const tagValue = readVarint(bytes, pos);
    pos = tagValue.next;
    const number = tagValue.value >>> 3;
    const wireType = tagValue.value & 7;

    if (number === 1 || number === 5) {
      if (wireType !== 0) throw new CastProtocolError(`field ${number} has wire type ${wireType}, expected varint`);
      const value = readVarint(bytes, pos);
      pos = value.next;
      if (number === 1) protocolVersion = value.value;
      else payloadType = value.value;
    } else if (number >= 2 && number <= 7) {
      if (wireType !== 2) throw new CastProtocolError(`field ${number} has wire type ${wireType}, expected length-delimited`);
      const chunk = readBytes(bytes, pos);
      pos = chunk.next;
      if (number === 2) sourceId = Buffer.from(chunk.value).toString("utf8");
      else if (number === 3) destinationId = Buffer.from(chunk.value).toString("utf8");
      else if (number === 4) namespace = Buffer.from(chunk.value).toString("utf8");
      else if (number === 6) payloadUtf8 = Buffer.from(chunk.value).toString("utf8");
      else payloadBinary = Buffer.from(chunk.value);
    } else {
      pos = skipField(bytes, pos, wireType);
    }
  }

  if (protocolVersion === undefined) throw new CastProtocolError("missing required field protocol_version");
  if (sourceId === undefined) throw new CastProtocolError("missing required field source_id");
  if (destinationId === undefined) throw new CastProtocolError("missing required field destination_id");
  if (namespace === undefined) throw new CastProtocolError("missing required field namespace");
  if (payloadType === undefined) throw new CastProtocolError("missing required field payload_type");
  if (protocolVersion !== 0) throw new CastProtocolError(`unsupported protocol_version ${protocolVersion}`);
  if (payloadType !== PayloadType.STRING && payloadType !== PayloadType.BINARY) {
    throw new CastProtocolError(`unknown payload_type ${payloadType}`);
  }

  const msg: CastMessage = {
    protocolVersion: 0,
    sourceId,
    destinationId,
    namespace,
    payloadType,
  };
  if (payloadUtf8 !== undefined) msg.payloadUtf8 = payloadUtf8;
  if (payloadBinary !== undefined) msg.payloadBinary = payloadBinary;
  return msg;
}
