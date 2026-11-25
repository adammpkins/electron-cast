/**
 * The quantizer an H.264 encoder used for a frame, read from the frame itself.
 *
 * Chrome's hardware encoders report it with each output (`BitstreamBufferMetadata::qp`; on Windows
 * media/gpu/windows/media_foundation_video_encode_accelerator_win.cc takes it from its own rate controller, which sets
 * the frame's QP, or from the encoder's `MFSampleExtension_VideoEncodeQP`), and `MediaVideoEncoderWrapper::OnEncodedFrame`
 * (media/cast/encoding/media_video_encoder_wrapper.cc) prefers it to the estimated complexity when it computes the
 * lossiness. WebCodecs runs the same encoders but hands the page no quantizer, so it is taken from where the encoder
 * wrote it: the slice QP, `26 + pic_init_qp_minus26 + slice_qp_delta` (ITU-T H.264 7.4.3).
 *
 * The syntax follows Chromium's `H264Parser` (media/parsers/h264_parser.cc: `ParseSPS`, `ParsePPS`,
 * `ParseSliceHeader`), cut down to the fields that sit in front of `slice_qp_delta`.
 */

import { BitReader, ParseError } from "./rbsp-reader.ts";

/** The largest H.264 quantizer, which `VideoEncodeAcceleratorAdapter::BitstreamBufferReady` normalizes by. */
export const H264_MAX_QP = 51;

/**
 * `VideoEncoderOutput::qp`: the quantizer normalized to [0, 1], as `VideoEncodeAcceleratorAdapter::BitstreamBufferReady`
 * (media/video/video_encode_accelerator_adapter.cc) does for H.264.
 */
export function normalizedH264Quantizer(qp: number): number {
  return Math.min(Math.max(qp / H264_MAX_QP, 0), 1);
}

interface Sps {
  /** `ChromaArrayType`: 0 when the colour planes are coded separately. */
  chromaArrayType: number;
  separateColourPlane: boolean;
  log2MaxFrameNum: number;
  picOrderCntType: number;
  log2MaxPicOrderCntLsb: number;
  deltaPicOrderAlwaysZero: boolean;
  frameMbsOnly: boolean;
}

interface Pps {
  spsId: number;
  entropyCodingMode: boolean;
  bottomFieldPicOrderInFramePresent: boolean;
  numRefIdxL0DefaultActiveMinus1: number;
  numRefIdxL1DefaultActiveMinus1: number;
  weightedPred: boolean;
  weightedBipredIdc: number;
  picInitQpMinus26: number;
  redundantPicCntPresent: boolean;
}

const NAL_NON_IDR_SLICE = 1;
const NAL_IDR_SLICE = 5;
const NAL_SPS = 7;
const NAL_PPS = 8;
/** Profiles whose SPS carries the chroma format and scaling lists (`H264Parser::ParseSPS`). */
const HIGH_PROFILES = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135]);
/** A slice header ends well inside this many bytes; the slice data after it is not read. */
const SLICE_HEADER_BYTES = 256;

/** 7.3.2.1.1.1 scaling_list: read and discarded. */
function skipScalingList(r: BitReader, size: number): void {
  let lastScale = 8;
  let nextScale = 8;
  for (let j = 0; j < size; j++) {
    if (nextScale !== 0) nextScale = (lastScale + r.se() + 256) % 256;
    lastScale = nextScale === 0 ? lastScale : nextScale;
  }
}

function parseSps(r: BitReader): { id: number; sps: Sps } {
  const profileIdc = r.bits(8);
  r.bits(16); // constraint flags, level_idc
  const id = r.ue();
  let chromaFormatIdc = 1;
  let separateColourPlane = false;
  if (HIGH_PROFILES.has(profileIdc)) {
    chromaFormatIdc = r.ue();
    if (chromaFormatIdc === 3) separateColourPlane = r.bit() === 1;
    r.ue(); // bit_depth_luma_minus8
    r.ue(); // bit_depth_chroma_minus8
    r.bit(); // qpprime_y_zero_transform_bypass_flag
    if (r.bit() === 1) {
      const lists = chromaFormatIdc !== 3 ? 8 : 12;
      for (let i = 0; i < lists; i++) if (r.bit() === 1) skipScalingList(r, i < 6 ? 16 : 64);
    }
  }
  const log2MaxFrameNum = r.ue() + 4;
  const picOrderCntType = r.ue();
  let log2MaxPicOrderCntLsb = 0;
  let deltaPicOrderAlwaysZero = false;
  if (picOrderCntType === 0) {
    log2MaxPicOrderCntLsb = r.ue() + 4;
  } else if (picOrderCntType === 1) {
    deltaPicOrderAlwaysZero = r.bit() === 1;
    r.se(); // offset_for_non_ref_pic
    r.se(); // offset_for_top_to_bottom_field
    const cycle = r.ue();
    if (cycle > 255) throw new ParseError("num_ref_frames_in_pic_order_cnt_cycle out of range");
    for (let i = 0; i < cycle; i++) r.se();
  }
  r.ue(); // max_num_ref_frames
  r.bit(); // gaps_in_frame_num_value_allowed_flag
  r.ue(); // pic_width_in_mbs_minus1
  r.ue(); // pic_height_in_map_units_minus1
  const frameMbsOnly = r.bit() === 1;
  if (log2MaxFrameNum > 16 || log2MaxPicOrderCntLsb > 16) throw new ParseError("SPS field out of range");
  return {
    id,
    sps: {
      chromaArrayType: separateColourPlane ? 0 : chromaFormatIdc,
      separateColourPlane,
      log2MaxFrameNum,
      picOrderCntType,
      log2MaxPicOrderCntLsb,
      deltaPicOrderAlwaysZero,
      frameMbsOnly,
    },
  };
}

function parsePps(r: BitReader): { id: number; pps: Pps } {
  const id = r.ue();
  const spsId = r.ue();
  const entropyCodingMode = r.bit() === 1;
  const bottomFieldPicOrderInFramePresent = r.bit() === 1;
  // Slice groups (FMO) are a Baseline tool no hardware encoder produces; `H264Parser::ParsePPS` refuses them too.
  if (r.ue() > 0) throw new ParseError("slice groups are not supported");
  const numRefIdxL0DefaultActiveMinus1 = r.ue();
  const numRefIdxL1DefaultActiveMinus1 = r.ue();
  const weightedPred = r.bit() === 1;
  const weightedBipredIdc = r.bits(2);
  const picInitQpMinus26 = r.se();
  r.se(); // pic_init_qs_minus26
  r.se(); // chroma_qp_index_offset
  r.bit(); // deblocking_filter_control_present_flag
  r.bit(); // constrained_intra_pred_flag
  const redundantPicCntPresent = r.bit() === 1;
  if (numRefIdxL0DefaultActiveMinus1 > 31 || numRefIdxL1DefaultActiveMinus1 > 31) throw new ParseError("PPS field out of range");
  return {
    id,
    pps: {
      spsId,
      entropyCodingMode,
      bottomFieldPicOrderInFramePresent,
      numRefIdxL0DefaultActiveMinus1,
      numRefIdxL1DefaultActiveMinus1,
      weightedPred,
      weightedBipredIdc,
      picInitQpMinus26,
      redundantPicCntPresent,
    },
  };
}

/** 7.3.3.1 ref_pic_list_modification for one list. */
function skipRefPicListModification(r: BitReader): void {
  if (r.bit() === 0) return;
  for (let i = 0; i < 64; i++) {
    const idc = r.ue();
    if (idc === 3) return;
    if (idc > 3) throw new ParseError("modification_of_pic_nums_idc out of range");
    r.ue(); // abs_diff_pic_num_minus1 or long_term_pic_num
  }
  throw new ParseError("ref_pic_list_modification too long");
}

/** 7.3.3.2 pred_weight_table for one list. */
function skipPredWeights(r: BitReader, entries: number, chroma: boolean): void {
  for (let i = 0; i < entries; i++) {
    if (r.bit() === 1) {
      r.se();
      r.se();
    }
    if (chroma && r.bit() === 1) {
      for (let j = 0; j < 4; j++) r.se();
    }
  }
}

/** `H264Parser::ParseSliceHeader` up to `slice_qp_delta`; returns the slice QP. */
function parseSliceQp(r: BitReader, nalRefIdc: number, idr: boolean, spsById: Map<number, Sps>, ppsById: Map<number, Pps>): number {
  r.ue(); // first_mb_in_slice
  const sliceType = r.ue() % 5;
  const isP = sliceType === 0;
  const isB = sliceType === 1;
  const isI = sliceType === 2;
  const isSp = sliceType === 3;
  const isSi = sliceType === 4;
  const pps = ppsById.get(r.ue());
  const sps = pps === undefined ? undefined : spsById.get(pps.spsId);
  if (pps === undefined || sps === undefined) throw new ParseError("slice refers to a parameter set that was not seen");

  if (sps.separateColourPlane) r.bits(2); // colour_plane_id
  r.bits(sps.log2MaxFrameNum); // frame_num
  let fieldPic = false;
  if (!sps.frameMbsOnly) {
    fieldPic = r.bit() === 1;
    if (fieldPic) r.bit(); // bottom_field_flag
  }
  if (idr) r.ue(); // idr_pic_id
  if (sps.picOrderCntType === 0) {
    r.bits(sps.log2MaxPicOrderCntLsb); // pic_order_cnt_lsb
    if (pps.bottomFieldPicOrderInFramePresent && !fieldPic) r.se(); // delta_pic_order_cnt_bottom
  } else if (sps.picOrderCntType === 1 && !sps.deltaPicOrderAlwaysZero) {
    r.se(); // delta_pic_order_cnt[0]
    if (pps.bottomFieldPicOrderInFramePresent && !fieldPic) r.se(); // delta_pic_order_cnt[1]
  }
  if (pps.redundantPicCntPresent) r.ue(); // redundant_pic_cnt
  if (isB) r.bit(); // direct_spatial_mv_pred_flag

  let numRefIdxL0ActiveMinus1 = pps.numRefIdxL0DefaultActiveMinus1;
  let numRefIdxL1ActiveMinus1 = pps.numRefIdxL1DefaultActiveMinus1;
  if (isP || isSp || isB) {
    if (r.bit() === 1) {
      numRefIdxL0ActiveMinus1 = r.ue();
      if (isB) numRefIdxL1ActiveMinus1 = r.ue();
    }
  }
  if (numRefIdxL0ActiveMinus1 > 31 || numRefIdxL1ActiveMinus1 > 31) throw new ParseError("num_ref_idx_active out of range");

  if (!isI && !isSi) skipRefPicListModification(r);
  if (isB) skipRefPicListModification(r);

  if ((pps.weightedPred && (isP || isSp)) || (pps.weightedBipredIdc === 1 && isB)) {
    const chroma = sps.chromaArrayType !== 0;
    r.ue(); // luma_log2_weight_denom
    if (chroma) r.ue(); // chroma_log2_weight_denom
    skipPredWeights(r, numRefIdxL0ActiveMinus1 + 1, chroma);
    if (isB) skipPredWeights(r, numRefIdxL1ActiveMinus1 + 1, chroma);
  }

  if (nalRefIdc !== 0) {
    // dec_ref_pic_marking
    if (idr) {
      r.bits(2); // no_output_of_prior_pics_flag, long_term_reference_flag
    } else if (r.bit() === 1) {
      for (let i = 0; ; i++) {
        if (i >= 64) throw new ParseError("dec_ref_pic_marking too long");
        const operation = r.ue();
        if (operation === 0) break;
        if (operation > 6) throw new ParseError("memory_management_control_operation out of range");
        if (operation === 1 || operation === 3) r.ue(); // difference_of_pic_nums_minus1
        if (operation === 2) r.ue(); // long_term_pic_num
        if (operation === 3 || operation === 6) r.ue(); // long_term_frame_idx
        if (operation === 4) r.ue(); // max_long_term_frame_idx_plus1
      }
    }
  }

  if (pps.entropyCodingMode && !isI && !isSi) r.ue(); // cabac_init_idc
  const qp = 26 + pps.picInitQpMinus26 + r.se();
  if (qp < 0 || qp > H264_MAX_QP) throw new ParseError("slice QP out of range");
  return qp;
}

/**
 * Reads the slice QP of Annex B frames from one encoder. It keeps the parameter sets, which an encoder repeats only
 * with its key frames.
 */
export class H264QuantizerReader {
  private readonly sps = new Map<number, Sps>();
  private readonly pps = new Map<number, Pps>();

  /**
   * The QP of the frame's first slice, or undefined when the frame has none that can be read (not Annex B, a
   * parameter set that was never seen, a syntax this reader does not cover).
   */
  read(frame: Uint8Array): number | undefined {
    const end = frame.length;
    let i = 0;
    // Each NAL unit follows a 00 00 01 start code; the unit ends where the next start code begins.
    while (i + 3 < end) {
      if (frame[i] !== 0 || frame[i + 1] !== 0 || frame[i + 2] !== 1) {
        i++;
        continue;
      }
      const header = frame[i + 3]!;
      const start = i + 4;
      const nalRefIdc = (header >> 5) & 3;
      const type = header & 0x1f;
      try {
        if (type === NAL_NON_IDR_SLICE || type === NAL_IDR_SLICE) {
          const r = new BitReader(frame, start, end, SLICE_HEADER_BYTES);
          return parseSliceQp(r, nalRefIdc, type === NAL_IDR_SLICE, this.sps, this.pps);
        }
        if (type === NAL_SPS || type === NAL_PPS) {
          let next = start;
          while (next + 2 < end && !(frame[next] === 0 && frame[next + 1] === 0 && frame[next + 2] === 1)) next++;
          const nalEnd = next + 2 < end ? next : end;
          const r = new BitReader(frame, start, nalEnd, nalEnd - start);
          if (type === NAL_SPS) {
            const { id, sps } = parseSps(r);
            this.sps.set(id, sps);
          } else {
            const { id, pps } = parsePps(r);
            this.pps.set(id, pps);
          }
          i = nalEnd;
          continue;
        }
      } catch (error) {
        if (error instanceof ParseError) return undefined;
        throw error;
      }
      i = start;
    }
    return undefined;
  }
}
