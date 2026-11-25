import { CastProtocolError } from "./errors.ts";

/**
 * Minimal protobuf wire reading shared by the device authentication messages and the Cast revocation list. Not
 * exported from the package: only the typed decoders built on it are.
 */

/** Append a length-delimited field (wire type 2). */
export function lengthDelimited(fieldNumber: number, payload: Uint8Array): Buffer {
  const header: number[] = [(fieldNumber << 3) | 2];
  let length = payload.length;
  while (length >= 0x80) {
    header.push((length & 0x7f) | 0x80);
    length = Math.floor(length / 128);
  }
  header.push(length);
  return Buffer.concat([Buffer.from(header), payload]);
}

/**
 * Visit each field in order. Varints arrive as bigint (so uint64 survives), length-delimited fields as byte slices;
 * fixed-width fields are skipped. Throws {@link CastProtocolError} on truncated or unsupported input.
 */
export function forEachField(bytes: Uint8Array, visit: (number: number, wireType: number, value: bigint | Uint8Array) => void): void {
  let pos = 0;
  const varint = (): bigint => {
    let value = 0n;
    for (let i = 0; i < 10; i++) {
      const byte = bytes[pos++];
      if (byte === undefined) throw new CastProtocolError("varint runs past end of input");
      value |= BigInt(byte & 0x7f) << BigInt(7 * i);
      if ((byte & 0x80) === 0) return value;
    }
    throw new CastProtocolError("varint longer than 10 bytes");
  };
  while (pos < bytes.length) {
    const tag = varint();
    const number = Number(tag >> 3n);
    const wireType = Number(tag & 7n);
    if (wireType === 0) {
      visit(number, 0, varint());
    } else if (wireType === 2) {
      const length = Number(varint());
      if (pos + length > bytes.length) throw new CastProtocolError("length-delimited field runs past end of input");
      visit(number, 2, bytes.subarray(pos, pos + length));
      pos += length;
    } else if (wireType === 1 || wireType === 5) {
      const size = wireType === 1 ? 8 : 4;
      if (pos + size > bytes.length) throw new CastProtocolError("truncated fixed-size field");
      pos += size;
    } else {
      throw new CastProtocolError(`unsupported wire type ${wireType}`);
    }
  }
}
