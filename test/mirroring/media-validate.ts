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
