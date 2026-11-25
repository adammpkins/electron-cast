/**
 * Structural checks of encoded media, for the fake receiver. A receiver that rejects garbage is the point of
 * "decodes at least N valid packets": these are the headers a real decoder would refuse on.
 */

export interface Vp8FrameInfo {
  key: boolean;
  width?: number;
  height?: number;
}

/**
 * RFC 6386 section 9.1 "Uncompressed Data Chunk": a 3-byte frame tag whose lowest bit is 0 for a key frame and 1
 * for an inter frame; a key frame continues with the start code 9d 01 2a and 14-bit width and height (plus 2-bit scale).
 */
export function validateVp8Frame(data: Uint8Array): Vp8FrameInfo | undefined {
  if (data.length < 3) return undefined;
  const tag = data[0]! | (data[1]! << 8) | (data[2]! << 16);
  const key = (tag & 1) === 0;
  const version = (tag >> 1) & 7;
  const showFrame = (tag >> 4) & 1;
  const firstPartSize = tag >> 5;
  if (version > 3 || showFrame > 1) return undefined;
  if (!key) return firstPartSize <= data.length - 3 ? { key } : undefined;
  if (data.length < 10 || data[3] !== 0x9d || data[4] !== 0x01 || data[5] !== 0x2a) return undefined;
  const width = (data[6]! | (data[7]! << 8)) & 0x3fff;
  const height = (data[8]! | (data[9]! << 8)) & 0x3fff;
  if (width === 0 || height === 0) return undefined;
  return { key, width, height };
}

/**
 * RFC 6716 section 3.1 "The TOC Byte": config (5 bits), stereo (1 bit), frame count code (2 bits). Code 3 carries a
 * frame count byte (1..48 frames); the packet may not be empty.
 */
export function validateOpusPacket(data: Uint8Array): boolean {
  if (data.length < 1) return false;
  const code = data[0]! & 3;
  if (code === 3) {
    if (data.length < 2) return false;
    const frames = data[1]! & 0x3f;
    return frames >= 1 && frames <= 48;
  }
  return true;
}

export interface H264FrameInfo {
  key: boolean;
  /** The coded picture size from the SPS of a key frame, after cropping. */
  width?: number;
  height?: number;
  /** NAL unit types in order. */
  nalTypes: number[];
}

/**
 * H.264 as Cast Streaming carries it: Annex B (ITU-T H.264 Annex B), NAL units behind 00 00 01 or 00 00 00 01 start codes,
 * with the parameter sets in the key frame. A key frame holds an SPS (7), a PPS (8) and an IDR slice (5), the SPS and
 * PPS first; an inter frame holds slices of type 1 and no IDR. Length-prefixed AVC data, which WebCodecs produces by
 * default, has no start code and is refused.
 */
export function validateH264Frame(data: Uint8Array): H264FrameInfo | undefined {
  const starts: number[] = [];
  for (let i = 0; i + 3 <= data.length; i++) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
      starts.push(i + 3);
      i += 2;
    }
  }
  if (starts.length === 0 || starts[0]! > 4) return undefined;
  const nalTypes: number[] = [];
  for (const s of starts) {
    if (s >= data.length) return undefined;
    const header = data[s]!;
    if ((header & 0x80) !== 0) return undefined;
    nalTypes.push(header & 0x1f);
  }
  const idr = nalTypes.indexOf(5);
  if (idr >= 0) {
    const sps = nalTypes.indexOf(7);
    const pps = nalTypes.indexOf(8);
    if (sps < 0 || pps < 0 || sps > idr || pps > idr) return undefined;
    const size = parseSpsSize(data, starts[sps]!, starts[sps + 1] === undefined ? data.length : starts[sps + 1]! - 3);
    return { key: true, nalTypes, ...size };
  }
  return nalTypes.includes(1) ? { key: false, nalTypes } : undefined;
}

/** ITU-T H.264 7.3.2.1.1 `seq_parameter_set_data`, far enough to read the picture size (Exp-Golomb coded). */
function parseSpsSize(data: Uint8Array, start: number, end: number): { width: number; height: number } | undefined {
  // Remove emulation prevention bytes (00 00 03).
  const rbsp: number[] = [];
  for (let i = start + 1; i < end; i++) {
    if (i >= start + 3 && data[i] === 3 && data[i - 1] === 0 && data[i - 2] === 0) continue;
    rbsp.push(data[i]!);
  }
  let pos = 0;
  const bit = (): number => {
    const b = (rbsp[pos >> 3] ?? 0) >> (7 - (pos & 7)) & 1;
    pos++;
    return b;
  };
  const bits = (n: number): number => {
    let v = 0;
    for (let i = 0; i < n; i++) v = v * 2 + bit();
    return v;
  };
  const ue = (): number => {
    let zeros = 0;
    while (bit() === 0 && zeros < 32) zeros++;
    return 2 ** zeros - 1 + bits(zeros);
  };
  const se = (): number => {
    const k = ue();
    return k % 2 === 1 ? (k + 1) / 2 : -k / 2;
  };
  const profile = bits(8);
  bits(16);
  ue();
  let chroma = 1;
  if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profile)) {
    chroma = ue();
    if (chroma === 3) bit();
    ue();
    ue();
    bit();
    if (bit() === 1) {
      const lists = chroma !== 3 ? 8 : 12;
      for (let i = 0; i < lists; i++) {
        if (bit() === 1) {
          let last = 8;
          let next = 8;
          for (let j = 0; j < (i < 6 ? 16 : 64); j++) {
            if (next !== 0) next = (last + se() + 256) % 256;
            last = next === 0 ? last : next;
          }
        }
      }
    }
  }
  ue();
  const pocType = ue();
  if (pocType === 0) ue();
  else if (pocType === 1) {
    bit();
    se();
    se();
    const n = ue();
    for (let i = 0; i < n; i++) se();
  }
  ue();
  bit();
  const widthMbs = ue() + 1;
  const heightMapUnits = ue() + 1;
  const frameMbsOnly = bit();
  if (frameMbsOnly === 0) bit();
  bit();
  let cropLeft = 0, cropRight = 0, cropTop = 0, cropBottom = 0;
  if (bit() === 1) {
    cropLeft = ue();
    cropRight = ue();
    cropTop = ue();
    cropBottom = ue();
  }
  const cropUnitX = chroma === 0 ? 1 : chroma === 3 ? 1 : 2;
  const cropUnitY = (chroma === 1 ? 2 : 1) * (2 - frameMbsOnly);
  const width = widthMbs * 16 - cropUnitX * (cropLeft + cropRight);
  const height = (2 - frameMbsOnly) * heightMapUnits * 16 - cropUnitY * (cropTop + cropBottom);
  return width > 0 && height > 0 && width <= 16384 && height <= 16384 ? { width, height } : undefined;
}
