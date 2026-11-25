/**
 * The quantizer a VP8 or VP9 encoder used for a frame, read from the frame itself.
 *
 * Chrome's software encoder asks libvpx for it after each frame (`VpxVideoEncoder::GetEncoderOutput`,
 * media/video/vpx_video_encoder.cc: `VP8E_GET_LAST_QUANTIZER_64` over `kMaxVpxQuantizer`, 63), and its hardware
 * encoders report the frame's q index, which `VideoEncodeAcceleratorAdapter::BitstreamBufferReady`
 * (media/video/video_encode_accelerator_adapter.cc) divides by 127 for VP8 and 255 for VP9.
 * `MediaVideoEncoderWrapper::OnEncodedFrame` (media/cast/encoding/media_video_encoder_wrapper.cc) prefers either to the
 * estimated complexity when it computes the lossiness. WebCodecs runs the same encoders but hands the page no
 * quantizer, so it is taken from where the encoder wrote it: the base q index of the frame header.
 *
 * libvpx's control answers on its 0 to 63 scale, not with the q index: `get_quantizer64` (vp8/vp8_cx_iface.c) is
 * `vp8_reverse_trans(cpi->common.base_qindex)` and `ctrl_get_quantizer64` (vp9/vp9_cx_iface.c) is
 * `vp9_qindex_to_quantizer(cpi->common.base_qindex)`. Both are ported here, so a software frame is normalized as
 * Chrome normalizes it.
 */
import { ParseError } from "./rbsp-reader.ts";

/** `kMaxVpxQuantizer` of `VpxVideoEncoder::GetEncoderOutput`. */
export const VPX_MAX_QUANTIZER = 63;
/** The largest VP8 q index, which `VideoEncodeAcceleratorAdapter::BitstreamBufferReady` normalizes by. */
export const VP8_MAX_Q_INDEX = 127;
/** The largest VP9 q index, which `VideoEncodeAcceleratorAdapter::BitstreamBufferReady` normalizes by. */
export const VP9_MAX_Q_INDEX = 255;

/** libvpx vp8/encoder/onyx_if.c `q_trans`: the q index of each quantizer on the 0 to 63 scale. */
const VP8_QUANTIZER_TO_Q_INDEX = [
  0, 1, 2, 3, 4, 5, 7, 8, 9, 10, 12, 13, 15, 17, 18, 19,
  20, 21, 23, 24, 25, 26, 27, 28, 29, 30, 31, 33, 35, 37, 39, 41,
  43, 45, 47, 49, 51, 53, 55, 57, 59, 61, 64, 67, 70, 73, 76, 79,
  82, 85, 88, 91, 94, 97, 100, 103, 106, 109, 112, 115, 118, 121, 124, 127,
];

/** libvpx vp9/encoder/vp9_quantize.c `quantizer_to_qindex`. */
const VP9_QUANTIZER_TO_Q_INDEX = [
  0, 4, 8, 12, 16, 20, 24, 28, 32, 36, 40, 44, 48,
  52, 56, 60, 64, 68, 72, 76, 80, 84, 88, 92, 96, 100,
  104, 108, 112, 116, 120, 124, 128, 132, 136, 140, 144, 148, 152,
  156, 160, 164, 168, 172, 176, 180, 184, 188, 192, 196, 200, 204,
  208, 212, 216, 220, 224, 228, 232, 236, 240, 244, 249, 255,
];

/** The first quantizer whose q index is not below the one given, 63 when there is none. */
function reverse(table: readonly number[], qIndex: number): number {
  for (let quantizer = 0; quantizer < table.length; quantizer++) {
    if (table[quantizer]! >= qIndex) return quantizer;
  }
  return VPX_MAX_QUANTIZER;
}

/** libvpx `vp8_reverse_trans` (vp8/encoder/onyx_if.c): a VP8 q index on the 0 to 63 scale. */
export function vp8QIndexToQuantizer(qIndex: number): number {
  return reverse(VP8_QUANTIZER_TO_Q_INDEX, qIndex);
}

/** libvpx `vp9_qindex_to_quantizer` (vp9/encoder/vp9_quantize.c): a VP9 q index on the 0 to 63 scale. */
export function vp9QIndexToQuantizer(qIndex: number): number {
  return reverse(VP9_QUANTIZER_TO_Q_INDEX, qIndex);
}

/** The boolean entropy decoder of RFC 6386 section 7.3, which the VP8 frame header is coded with. */
class BoolDecoder {
  private readonly data: Uint8Array;
  private position: number;
  private value: number;
  private range = 255;
  private bitCount = 0;

  constructor(data: Uint8Array, start: number) {
    if (start + 2 > data.length) throw new ParseError("out of data");
    this.data = data;
    this.value = (data[start]! << 8) | data[start + 1]!;
    this.position = start + 2;
  }

  bool(probability: number): number {
    const split = 1 + (((this.range - 1) * probability) >> 8);
    const bigSplit = split << 8;
    let bit = 0;
    if (this.value >= bigSplit) {
      bit = 1;
      this.range -= split;
      this.value -= bigSplit;
    } else {
      this.range = split;
    }
    while (this.range < 128) {
      this.value <<= 1;
      this.range <<= 1;
      if (++this.bitCount === 8) {
        this.bitCount = 0;
        if (this.position >= this.data.length) throw new ParseError("out of data");
        this.value |= this.data[this.position++]!;
      }
    }
    return bit;
  }

  /** L(n): an unsigned value of n bits, each with an even probability. */
  literal(bits: number): number {
    let value = 0;
    for (let i = 0; i < bits; i++) value = (value << 1) | this.bool(128);
    return value;
  }

  flag(): boolean {
    return this.bool(128) === 1;
  }
}

/**
 * The base q index (`y_ac_qi`, 0 to 127) of a VP8 frame, or undefined when the data is not a frame whose header can be
 * read. RFC 6386 sections 9.1 to 9.6 and 19.2; the order of the fields is that of Chromium's `Vp8Parser`
 * (media/parsers/vp8_parser.cc: `ParseFrameTag`, `ParseFrameHeader`, `ParseSegmentationHeader`,
 * `ParseLoopFilterHeader`, `ParseQuantizationHeader`).
 */
export function readVp8QIndex(frame: Uint8Array): number | undefined {
  if (frame.length < 3) return undefined;
  const keyFrame = (frame[0]! & 1) === 0;
  let start = 3;
  if (keyFrame) {
    // The start code, then 14 bits of width and of height with their scales.
    if (frame.length < 10 || frame[3] !== 0x9d || frame[4] !== 0x01 || frame[5] !== 0x2a) return undefined;
    start = 10;
  }
  try {
    const d = new BoolDecoder(frame, start);
    if (keyFrame) d.literal(2); // color_space, clamping_type
    if (d.flag()) {
      // segmentation_enabled
      const updateMap = d.flag();
      if (d.flag()) {
        // update_segment_feature_data
        d.literal(1); // segment_feature_mode
        for (let i = 0; i < 4; i++) if (d.flag()) d.literal(8); // quantizer_update_value, with its sign
        for (let i = 0; i < 4; i++) if (d.flag()) d.literal(7); // lf_update_value, with its sign
      }
      if (updateMap) for (let i = 0; i < 3; i++) if (d.flag()) d.literal(8); // segment_prob
    }
    d.literal(10); // filter type, loop_filter_level, sharpness_level
    if (d.flag() && d.flag()) {
      // loop_filter_adj_enable, mode_ref_lf_delta_update
      for (let i = 0; i < 8; i++) if (d.flag()) d.literal(7); // ref_frame_delta and mb_mode_delta, with their signs
    }
    d.literal(2); // log2_nbr_of_dct_partitions
    return d.literal(7); // y_ac_qi
  } catch (error) {
    if (error instanceof ParseError) return undefined;
    throw error;
  }
}

/** The plain bits of a VP9 uncompressed header. */
class Bits {
  private readonly data: Uint8Array;
  private position: number;
  private readonly end: number;

  constructor(data: Uint8Array, start: number, end: number) {
    this.data = data;
    this.position = start * 8;
    this.end = end * 8;
  }

  bit(): number {
    if (this.position >= this.end) throw new ParseError("out of data");
    const value = (this.data[this.position >> 3]! >> (7 - (this.position & 7))) & 1;
    this.position++;
    return value;
  }

  bits(count: number): number {
    let value = 0;
    for (let i = 0; i < count; i++) value = value * 2 + this.bit();
    return value;
  }
}

const VP9_SYNC_CODE = 0x498342;
const VP9_COLOR_SPACE_RGB = 7;

/** 6.2.2 color_config (`Vp9UncompressedHeaderParser::ReadColorConfig`). */
function skipVp9ColorConfig(r: Bits, profile: number): void {
  if (profile >= 2) r.bit(); // ten_or_twelve_bit
  const subsampled = profile === 1 || profile === 3;
  if (r.bits(3) !== VP9_COLOR_SPACE_RGB) {
    r.bit(); // color_range
    if (subsampled) r.bits(3); // subsampling_x, subsampling_y, reserved_zero
  } else if (subsampled) {
    r.bit(); // reserved_zero
  } else {
    throw new ParseError("RGB is not allowed in this profile");
  }
}

/** 6.2.3 frame_size. */
function skipVp9FrameSize(r: Bits): void {
  r.bits(32); // frame_width_minus_1, frame_height_minus_1
}

/** 6.2.4 render_size. */
function skipVp9RenderSize(r: Bits): void {
  if (r.bit() === 1) r.bits(32); // render_width_minus_1, render_height_minus_1
}

/**
 * `base_q_idx` of one VP9 frame, or undefined for a frame that only shows an earlier one (`show_existing_frame`).
 * VP9 bitstream specification sections 6.2 and 7.2, in the order of `Vp9UncompressedHeaderParser::Parse`
 * (media/parsers/vp9_uncompressed_header_parser.cc).
 */
function readVp9FrameQIndex(data: Uint8Array, start: number, end: number): number | undefined {
  const r = new Bits(data, start, end);
  if (r.bits(2) !== 2) throw new ParseError("not a VP9 frame"); // frame_marker
  const profile = r.bit() + 2 * r.bit(); // profile_low_bit, profile_high_bit
  if (profile === 3 && r.bit() === 1) throw new ParseError("reserved profile");
  if (r.bit() === 1) return undefined; // show_existing_frame
  const keyFrame = r.bit() === 0; // frame_type
  const showFrame = r.bit() === 1;
  const errorResilient = r.bit() === 1;
  if (keyFrame) {
    if (r.bits(24) !== VP9_SYNC_CODE) throw new ParseError("no frame sync code");
    skipVp9ColorConfig(r, profile);
    skipVp9FrameSize(r);
    skipVp9RenderSize(r);
  } else {
    const intraOnly = showFrame ? false : r.bit() === 1;
    if (!errorResilient) r.bits(2); // reset_frame_context
    if (intraOnly) {
      if (r.bits(24) !== VP9_SYNC_CODE) throw new ParseError("no frame sync code");
      if (profile > 0) skipVp9ColorConfig(r, profile);
      r.bits(8); // refresh_frame_flags
      skipVp9FrameSize(r);
      skipVp9RenderSize(r);
    } else {
      r.bits(8); // refresh_frame_flags
      r.bits(12); // three times ref_frame_idx and ref_frame_sign_bias
      // 6.2.5 frame_size_with_refs (`ReadFrameSizeFromRefs`): the size of a reference, or one of its own.
      let foundRef = false;
      for (let i = 0; i < 3 && !foundRef; i++) foundRef = r.bit() === 1;
      if (!foundRef) skipVp9FrameSize(r);
      skipVp9RenderSize(r);
      r.bit(); // allow_high_precision_mv
      if (r.bit() === 0) r.bits(2); // is_filter_switchable, raw_interpolation_filter
    }
  }
  if (!errorResilient) r.bits(2); // refresh_frame_context, frame_parallel_decoding_mode
  r.bits(2); // frame_context_idx
  // 6.2.8 loop_filter_params (`ReadLoopFilterParams`).
  r.bits(9); // loop_filter_level, loop_filter_sharpness
  if (r.bit() === 1 && r.bit() === 1) {
    // loop_filter_delta_enabled, loop_filter_delta_update
    for (let i = 0; i < 6; i++) if (r.bit() === 1) r.bits(7); // four reference deltas and two mode deltas, su(6)
  }
  // 6.2.9 quantization_params (`ReadQuantizationParams`).
  return r.bits(8);
}

/**
 * The frames of a chunk: one, or those a superframe index at the end of the chunk lists (VP9 bitstream specification
 * Annex B; `Vp9Parser::ParseSuperframe`, media/parsers/vp9_parser.cc).
 */
function vp9Frames(chunk: Uint8Array): { start: number; end: number }[] {
  const whole = [{ start: 0, end: chunk.length }];
  const marker = chunk[chunk.length - 1]!;
  if ((marker & 0xe0) !== 0xc0) return whole;
  const count = (marker & 7) + 1;
  const sizeBytes = ((marker >> 3) & 3) + 1;
  const indexSize = 2 + count * sizeBytes;
  if (chunk.length < indexSize || chunk[chunk.length - indexSize] !== marker) return whole;
  const frames: { start: number; end: number }[] = [];
  let at = chunk.length - indexSize + 1;
  let start = 0;
  for (let i = 0; i < count; i++) {
    let size = 0;
    for (let b = 0; b < sizeBytes; b++) size += chunk[at++]! * 2 ** (8 * b);
    if (start + size > chunk.length - indexSize) throw new ParseError("superframe index past the data");
    // A frame of no bytes is skipped, as `ParseSuperframe` skips it.
    if (size > 0) frames.push({ start, end: start + size });
    start += size;
  }
  return frames;
}

/**
 * The base q index (`base_q_idx`, 0 to 255) of a VP9 chunk, or undefined when it has none that can be read. libvpx
 * reports the quantizer of the frame it coded last, so a superframe gives that of its last frame that codes one.
 */
export function readVp9QIndex(chunk: Uint8Array): number | undefined {
  if (chunk.length === 0) return undefined;
  try {
    let qIndex: number | undefined;
    for (const { start, end } of vp9Frames(chunk)) {
      const q = readVp9FrameQIndex(chunk, start, end);
      if (q !== undefined) qIndex = q;
    }
    return qIndex;
  } catch (error) {
    if (error instanceof ParseError) return undefined;
    throw error;
  }
}
