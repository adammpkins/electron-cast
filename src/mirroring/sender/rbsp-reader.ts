/**
 * The bits of an H.264 or HEVC NAL unit, for the readers that take an encoder's quantizer from its own output
 * (h264-quantizer.ts, h265-quantizer.ts). What Chromium's `H264BitReader` (media/parsers/h264_bit_reader.cc) does.
 */

/** The syntax ended early, or is one the reader does not cover: the frame has no readable quantizer. */
export class ParseError extends Error {}

/** Reads the bits of an RBSP: the NAL unit's payload with its emulation prevention bytes (00 00 03) taken out. */
export class BitReader {
  private readonly bytes: Uint8Array;
  private position = 0;

  /** `limit` bounds the work for a slice, whose header is in its first bytes. */
  constructor(nal: Uint8Array, start: number, end: number, limit: number) {
    const out = new Uint8Array(Math.min(end - start, limit));
    let n = 0;
    let zeros = 0;
    for (let i = start; i < end && n < out.length; i++) {
      const b = nal[i]!;
      if (zeros >= 2 && b === 3) {
        zeros = 0;
        continue;
      }
      zeros = b === 0 ? zeros + 1 : 0;
      out[n++] = b;
    }
    this.bytes = out.subarray(0, n);
  }

  bit(): number {
    const byte = this.position >> 3;
    if (byte >= this.bytes.length) throw new ParseError("out of data");
    const value = (this.bytes[byte]! >> (7 - (this.position & 7))) & 1;
    this.position++;
    return value;
  }

  bits(count: number): number {
    let value = 0;
    for (let i = 0; i < count; i++) value = value * 2 + this.bit();
    return value;
  }

  /** ue(v), an unsigned Exp-Golomb code. */
  ue(): number {
    let zeros = 0;
    while (this.bit() === 0) {
      if (++zeros > 31) throw new ParseError("Exp-Golomb code too long");
    }
    return 2 ** zeros - 1 + this.bits(zeros);
  }

  /** se(v), a signed Exp-Golomb code. */
  se(): number {
    const code = this.ue();
    return code % 2 === 1 ? (code + 1) / 2 : -(code / 2);
  }
}
