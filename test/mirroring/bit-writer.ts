/** Writes the bits of the hand-built frame headers the quantizer tests read. */
export class BitWriter {
  private readonly bitsOut: number[] = [];

  u(count: number, value: number): this {
    for (let i = count - 1; i >= 0; i--) this.bitsOut.push(Math.floor(value / 2 ** i) % 2);
    return this;
  }

  /** An unsigned Exp-Golomb code. */
  ue(value: number): this {
    const code = value + 1;
    const length = Math.floor(Math.log2(code)) + 1;
    return this.u(length - 1, 0).u(length, code);
  }

  /** A signed Exp-Golomb code. */
  se(value: number): this {
    return this.ue(value > 0 ? 2 * value - 1 : -2 * value);
  }

  /** The bits as bytes, the last one padded with zeros. */
  bytes(): number[] {
    const bits = [...this.bitsOut];
    while (bits.length % 8 !== 0) bits.push(0);
    const out: number[] = [];
    for (let i = 0; i < bits.length; i += 8) out.push(bits.slice(i, i + 8).reduce((a, b) => a * 2 + b, 0));
    return out;
  }

  /** The payload of a NAL unit: the bits, the RBSP stop bit, and the emulation prevention bytes. */
  private payload(): number[] {
    const bits = [...this.bitsOut, 1];
    while (bits.length % 8 !== 0) bits.push(0);
    const out: number[] = [];
    let zeros = 0;
    for (let i = 0; i < bits.length; i += 8) {
      const byte = bits.slice(i, i + 8).reduce((a, b) => a * 2 + b, 0);
      if (zeros >= 2 && byte <= 3) {
        out.push(3);
        zeros = 0;
      }
      out.push(byte);
      zeros = byte === 0 ? zeros + 1 : 0;
    }
    return out;
  }

  /** An H.264 NAL unit with a three byte start code. */
  nal(refIdc: number, type: number): number[] {
    return [0, 0, 1, (refIdc << 5) | type, ...this.payload()];
  }

  /** An HEVC NAL unit with a three byte start code: a two byte header, base layer, temporal id 0. */
  nalH265(type: number, layer = 0): number[] {
    return [0, 0, 1, (type << 1) | (layer >> 5), ((layer & 0x1f) << 3) | 1, ...this.payload()];
  }
}
