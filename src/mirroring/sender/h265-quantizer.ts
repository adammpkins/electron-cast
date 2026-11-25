/**
 * The quantizer an HEVC encoder used for a frame, read from the frame itself.
 *
 * Chrome's hardware encoders report it with each output (`BitstreamBufferMetadata::qp`), and
 * `VideoEncodeAcceleratorAdapter::BitstreamBufferReady` (media/video/video_encode_accelerator_adapter.cc) normalizes
 * it by 51, as it does for H.264. WebCodecs hands the page no quantizer, so it is taken from where the encoder wrote
 * it: the slice QP, `26 + init_qp_minus26 + slice_qp_delta` (ITU-T H.265 7.4.7.1, `SliceQpY`).
 *
 * The syntax follows Chromium's `H265Parser` (media/parsers/h265_parser.cc: `ParseSPS`, `ParsePPS`,
 * `ParseSliceHeader`, `ParseProfileTierLevel`, `ParseScalingListData`, `ParseStRefPicSet`,
 * `ParseRefPicListsModifications`, `ParsePredWeightTable`), cut down to the fields that sit in front of
 * `slice_qp_delta`.
 */
import { BitReader, ParseError } from "./rbsp-reader.ts";

/** The largest HEVC quantizer of 8-bit video, which `VideoEncodeAcceleratorAdapter::BitstreamBufferReady` normalizes by. */
export const H265_MAX_QP = 51;

/** One short-term reference picture set: whether each picture before and after the current one is used by it. */
interface StRefPicSet {
  deltaPocS0: number[];
  usedByCurrPicS0: boolean[];
  deltaPocS1: number[];
  usedByCurrPicS1: boolean[];
}

interface Sps {
  chromaArrayType: number;
  separateColourPlane: boolean;
  log2MaxPicOrderCntLsb: number;
  /** `QpBdOffsetY`, 6 for every bit of depth over 8: the slice QP may be this far below 0. */
  qpBdOffsetY: number;
  sampleAdaptiveOffsetEnabled: boolean;
  stRefPicSets: StRefPicSet[];
  longTermRefPicsPresent: boolean;
  usedByCurrPicLtSps: boolean[];
  temporalMvpEnabled: boolean;
}

interface Pps {
  spsId: number;
  dependentSliceSegmentsEnabled: boolean;
  outputFlagPresent: boolean;
  numExtraSliceHeaderBits: number;
  cabacInitPresent: boolean;
  numRefIdxL0DefaultActiveMinus1: number;
  numRefIdxL1DefaultActiveMinus1: number;
  initQpMinus26: number;
  weightedPred: boolean;
  weightedBipred: boolean;
  listsModificationPresent: boolean;
}

/** nal_unit_type (ITU-T H.265 table 7-1). */
const NAL_RASL_R = 9;
const NAL_BLA_W_LP = 16;
const NAL_IDR_W_RADL = 19;
const NAL_IDR_N_LP = 20;
const NAL_CRA = 21;
const NAL_RSV_IRAP_VCL23 = 23;
const NAL_SPS = 33;
const NAL_PPS = 34;
const SLICE_B = 0;
const SLICE_P = 1;
const SLICE_I = 2;
/** `kMaxShortTermRefPicSets`, `kMaxLongTermRefPicSets`, `kMaxRefIdxActive` of h265_parser.h. */
const MAX_SHORT_TERM_REF_PIC_SETS = 64;
const MAX_LONG_TERM_REF_PIC_SETS = 32;
const MAX_REF_IDX_ACTIVE = 15;
/** A slice header ends well inside this many bytes; the slice data after it is not read. */
const SLICE_HEADER_BYTES = 512;

const flag = (r: BitReader): boolean => r.bit() === 1;

/** Ceil(Log2(x)), the width of a field that indexes `x` entries. */
function log2Ceiling(x: number): number {
  let bits = 0;
  while (2 ** bits < x) bits++;
  return bits;
}

function inRange(value: number, low: number, high: number, name: string): number {
  if (value < low || value > high) throw new ParseError(`${name} out of range`);
  return value;
}

/** 7.3.3 profile_tier_level with the general profile present (`ParseProfileTierLevel`). */
function skipProfileTierLevel(r: BitReader, maxSubLayersMinus1: number): void {
  // general_profile_space, general_tier_flag, general_profile_idc, 32 compatibility flags, 4 source flags, 43 reserved
  // bits, general_inbld_flag, general_level_idc.
  for (let i = 0; i < 12; i++) r.bits(8);
  const profilePresent: boolean[] = [];
  const levelPresent: boolean[] = [];
  for (let i = 0; i < maxSubLayersMinus1; i++) {
    profilePresent.push(flag(r));
    levelPresent.push(flag(r));
  }
  if (maxSubLayersMinus1 > 0) for (let i = maxSubLayersMinus1; i < 8; i++) r.bits(2); // reserved_zero_2bits
  for (let i = 0; i < maxSubLayersMinus1; i++) {
    if (profilePresent[i]) for (let b = 0; b < 11; b++) r.bits(8);
    if (levelPresent[i]) r.bits(8);
  }
}

/** 7.3.4 scaling_list_data, read and discarded (`ParseScalingListData`). */
function skipScalingListData(r: BitReader): void {
  for (let sizeId = 0; sizeId < 4; sizeId++) {
    for (let matrixId = 0; matrixId < 6; matrixId += sizeId === 3 ? 3 : 1) {
      if (!flag(r)) {
        r.ue(); // scaling_list_pred_matrix_id_delta
        continue;
      }
      const coefficients = Math.min(64, 2 ** (4 + sizeId * 2));
      if (sizeId > 1) r.se(); // scaling_list_dc_coef_minus8
      for (let i = 0; i < coefficients; i++) r.se(); // scaling_list_delta_coef
    }
  }
}

/**
 * 7.3.7 st_ref_pic_set (`ParseStRefPicSet`). A set may be predicted from an earlier one, so the pictures of each are
 * kept. `sets` are those of the sequence parameter set read so far and `index` is the set's place after them; the set
 * of a slice header (`ofSlice`) names the one it is predicted from, a set of the sequence uses the one before it.
 */
function parseStRefPicSet(r: BitReader, index: number, sets: readonly StRefPicSet[], ofSlice: boolean): StRefPicSet {
  const set: StRefPicSet = { deltaPocS0: [], usedByCurrPicS0: [], deltaPocS1: [], usedByCurrPicS1: [] };
  if (index !== 0 && flag(r)) {
    // inter_ref_pic_set_prediction_flag
    const deltaIdxMinus1 = ofSlice ? inRange(r.ue(), 0, index - 1, "delta_idx_minus1") : 0;
    const ref = sets[index - (deltaIdxMinus1 + 1)]!;
    const sign = r.bit(); // delta_rps_sign
    const deltaRps = (1 - 2 * sign) * (inRange(r.ue(), 0, 0x7fff, "abs_delta_rps_minus1") + 1);
    const negative = ref.deltaPocS0.length;
    const positive = ref.deltaPocS1.length;
    const used: boolean[] = [];
    const useDelta: boolean[] = [];
    for (let j = 0; j <= negative + positive; j++) {
      used.push(flag(r)); // used_by_curr_pic_flag
      useDelta.push(used[j]! ? true : flag(r)); // use_delta_flag, 1 when absent
    }
    const add = (s: 0 | 1, deltaPoc: number, j: number): void => {
      (s === 0 ? set.deltaPocS0 : set.deltaPocS1).push(deltaPoc);
      (s === 0 ? set.usedByCurrPicS0 : set.usedByCurrPicS1).push(used[j]!);
    };
    // Equation 7-61.
    for (let j = positive - 1; j >= 0; j--) {
      const d = ref.deltaPocS1[j]! + deltaRps;
      if (d < 0 && useDelta[negative + j]) add(0, d, negative + j);
    }
    if (deltaRps < 0 && useDelta[negative + positive]) add(0, deltaRps, negative + positive);
    for (let j = 0; j < negative; j++) {
      const d = ref.deltaPocS0[j]! + deltaRps;
      if (d < 0 && useDelta[j]) add(0, d, j);
    }
    // Equation 7-62.
    for (let j = negative - 1; j >= 0; j--) {
      const d = ref.deltaPocS0[j]! + deltaRps;
      if (d > 0 && useDelta[j]) add(1, d, j);
    }
    if (deltaRps > 0 && useDelta[negative + positive]) add(1, deltaRps, negative + positive);
    for (let j = 0; j < positive; j++) {
      const d = ref.deltaPocS1[j]! + deltaRps;
      if (d > 0 && useDelta[negative + j]) add(1, d, negative + j);
    }
    return set;
  }
  // The decoded picture buffer holds at most 16 pictures.
  const negative = inRange(r.ue(), 0, 16, "num_negative_pics");
  const positive = inRange(r.ue(), 0, 16 - negative, "num_positive_pics");
  let poc = 0;
  for (let i = 0; i < negative; i++) {
    poc -= inRange(r.ue(), 0, 0x7fff, "delta_poc_s0_minus1") + 1;
    set.deltaPocS0.push(poc);
    set.usedByCurrPicS0.push(flag(r));
  }
  poc = 0;
  for (let i = 0; i < positive; i++) {
    poc += inRange(r.ue(), 0, 0x7fff, "delta_poc_s1_minus1") + 1;
    set.deltaPocS1.push(poc);
    set.usedByCurrPicS1.push(flag(r));
  }
  return set;
}

/** 7.3.2.2 seq_parameter_set_rbsp, up to the last field a slice header depends on (`ParseSPS`). */
function parseSps(r: BitReader): { id: number; sps: Sps } {
  r.bits(4); // sps_video_parameter_set_id
  const maxSubLayersMinus1 = inRange(r.bits(3), 0, 6, "sps_max_sub_layers_minus1");
  r.bit(); // sps_temporal_id_nesting_flag
  skipProfileTierLevel(r, maxSubLayersMinus1);
  const id = inRange(r.ue(), 0, 15, "sps_seq_parameter_set_id");
  const chromaFormatIdc = inRange(r.ue(), 0, 3, "chroma_format_idc");
  const separateColourPlane = chromaFormatIdc === 3 && flag(r);
  r.ue(); // pic_width_in_luma_samples
  r.ue(); // pic_height_in_luma_samples
  if (flag(r)) for (let i = 0; i < 4; i++) r.ue(); // conformance_window_flag and its offsets
  const bitDepthLumaMinus8 = inRange(r.ue(), 0, 8, "bit_depth_luma_minus8");
  r.ue(); // bit_depth_chroma_minus8
  const log2MaxPicOrderCntLsb = inRange(r.ue(), 0, 12, "log2_max_pic_order_cnt_lsb_minus4") + 4;
  const subLayerOrderingInfoPresent = flag(r);
  for (let i = subLayerOrderingInfoPresent ? 0 : maxSubLayersMinus1; i <= maxSubLayersMinus1; i++) {
    r.ue(); // sps_max_dec_pic_buffering_minus1
    r.ue(); // sps_max_num_reorder_pics
    r.ue(); // sps_max_latency_increase_plus1
  }
  r.ue(); // log2_min_luma_coding_block_size_minus3
  r.ue(); // log2_diff_max_min_luma_coding_block_size
  r.ue(); // log2_min_luma_transform_block_size_minus2
  r.ue(); // log2_diff_max_min_luma_transform_block_size
  r.ue(); // max_transform_hierarchy_depth_inter
  r.ue(); // max_transform_hierarchy_depth_intra
  if (flag(r) && flag(r)) skipScalingListData(r); // scaling_list_enabled_flag, sps_scaling_list_data_present_flag
  r.bit(); // amp_enabled_flag
  const sampleAdaptiveOffsetEnabled = flag(r);
  if (flag(r)) {
    // pcm_enabled_flag
    r.bits(8); // pcm_sample_bit_depth_luma_minus1, pcm_sample_bit_depth_chroma_minus1
    r.ue(); // log2_min_pcm_luma_coding_block_size_minus3
    r.ue(); // log2_diff_max_min_pcm_luma_coding_block_size
    r.bit(); // pcm_loop_filter_disabled_flag
  }
  const setCount = inRange(r.ue(), 0, MAX_SHORT_TERM_REF_PIC_SETS, "num_short_term_ref_pic_sets");
  const stRefPicSets: StRefPicSet[] = [];
  for (let i = 0; i < setCount; i++) stRefPicSets.push(parseStRefPicSet(r, i, stRefPicSets, false));
  const longTermRefPicsPresent = flag(r);
  const usedByCurrPicLtSps: boolean[] = [];
  if (longTermRefPicsPresent) {
    const count = inRange(r.ue(), 0, MAX_LONG_TERM_REF_PIC_SETS, "num_long_term_ref_pics_sps");
    for (let i = 0; i < count; i++) {
      r.bits(log2MaxPicOrderCntLsb); // lt_ref_pic_poc_lsb_sps
      usedByCurrPicLtSps.push(flag(r));
    }
  }
  const temporalMvpEnabled = flag(r);
  return {
    id,
    sps: {
      chromaArrayType: separateColourPlane ? 0 : chromaFormatIdc,
      separateColourPlane,
      log2MaxPicOrderCntLsb,
      qpBdOffsetY: 6 * bitDepthLumaMinus8,
      sampleAdaptiveOffsetEnabled,
      stRefPicSets,
      longTermRefPicsPresent,
      usedByCurrPicLtSps,
      temporalMvpEnabled,
    },
  };
}

/** 7.3.2.3 pic_parameter_set_rbsp, up to `lists_modification_present_flag` (`ParsePPS`). */
function parsePps(r: BitReader): { id: number; pps: Pps } {
  const id = inRange(r.ue(), 0, 63, "pps_pic_parameter_set_id");
  const spsId = inRange(r.ue(), 0, 15, "pps_seq_parameter_set_id");
  const dependentSliceSegmentsEnabled = flag(r);
  const outputFlagPresent = flag(r);
  const numExtraSliceHeaderBits = r.bits(3);
  r.bit(); // sign_data_hiding_enabled_flag
  const cabacInitPresent = flag(r);
  const numRefIdxL0DefaultActiveMinus1 = inRange(r.ue(), 0, MAX_REF_IDX_ACTIVE - 1, "num_ref_idx_l0_default_active_minus1");
  const numRefIdxL1DefaultActiveMinus1 = inRange(r.ue(), 0, MAX_REF_IDX_ACTIVE - 1, "num_ref_idx_l1_default_active_minus1");
  const initQpMinus26 = r.se();
  r.bit(); // constrained_intra_pred_flag
  r.bit(); // transform_skip_enabled_flag
  if (flag(r)) r.ue(); // cu_qp_delta_enabled_flag, diff_cu_qp_delta_depth
  r.se(); // pps_cb_qp_offset
  r.se(); // pps_cr_qp_offset
  r.bit(); // pps_slice_chroma_qp_offsets_present_flag
  const weightedPred = flag(r);
  const weightedBipred = flag(r);
  r.bit(); // transquant_bypass_enabled_flag
  const tilesEnabled = flag(r);
  r.bit(); // entropy_coding_sync_enabled_flag
  if (tilesEnabled) {
    const columnsMinus1 = inRange(r.ue(), 0, 19, "num_tile_columns_minus1");
    const rowsMinus1 = inRange(r.ue(), 0, 21, "num_tile_rows_minus1");
    if (!flag(r)) {
      // uniform_spacing_flag
      for (let i = 0; i < columnsMinus1; i++) r.ue(); // column_width_minus1
      for (let i = 0; i < rowsMinus1; i++) r.ue(); // row_height_minus1
    }
    r.bit(); // loop_filter_across_tiles_enabled_flag
  }
  r.bit(); // pps_loop_filter_across_slices_enabled_flag
  if (flag(r)) {
    // deblocking_filter_control_present_flag
    r.bit(); // deblocking_filter_override_enabled_flag
    if (!flag(r)) {
      // pps_deblocking_filter_disabled_flag
      r.se(); // pps_beta_offset_div2
      r.se(); // pps_tc_offset_div2
    }
  }
  if (flag(r)) skipScalingListData(r); // pps_scaling_list_data_present_flag
  const listsModificationPresent = flag(r);
  return {
    id,
    pps: {
      spsId,
      dependentSliceSegmentsEnabled,
      outputFlagPresent,
      numExtraSliceHeaderBits,
      cabacInitPresent,
      numRefIdxL0DefaultActiveMinus1,
      numRefIdxL1DefaultActiveMinus1,
      initQpMinus26,
      weightedPred,
      weightedBipred,
      listsModificationPresent,
    },
  };
}

/** 7.3.6.3 pred_weight_table for one list (`ParsePredWeightTable`). */
function skipPredWeights(r: BitReader, entries: number, chroma: boolean): void {
  const luma: boolean[] = [];
  const chromaFlags: boolean[] = [];
  for (let i = 0; i < entries; i++) luma.push(flag(r));
  if (chroma) for (let i = 0; i < entries; i++) chromaFlags.push(flag(r));
  for (let i = 0; i < entries; i++) {
    if (luma[i]) {
      r.se(); // delta_luma_weight
      r.se(); // luma_offset
    }
    if (chromaFlags[i]) for (let j = 0; j < 4; j++) r.se(); // delta_chroma_weight and delta_chroma_offset, twice
  }
}

/** `H265Parser::ParseSliceHeader` up to `slice_qp_delta`; returns the slice QP. */
function parseSliceQp(r: BitReader, nalUnitType: number, spsById: Map<number, Sps>, ppsById: Map<number, Pps>): number {
  // The first NAL unit of a frame's slices starts its picture; a later segment gives no more than this one does.
  if (!flag(r)) throw new ParseError("not the first slice segment of the picture");
  if (nalUnitType >= NAL_BLA_W_LP && nalUnitType <= NAL_RSV_IRAP_VCL23) r.bit(); // no_output_of_prior_pics_flag
  const pps = ppsById.get(inRange(r.ue(), 0, 63, "slice_pic_parameter_set_id"));
  const sps = pps === undefined ? undefined : spsById.get(pps.spsId);
  if (pps === undefined || sps === undefined) throw new ParseError("slice refers to a parameter set that was not seen");

  r.bits(pps.numExtraSliceHeaderBits); // slice_reserved_flag
  const sliceType = inRange(r.ue(), 0, 2, "slice_type");
  if (pps.outputFlagPresent) r.bit(); // pic_output_flag
  if (sps.separateColourPlane) r.bits(2); // colour_plane_id

  let numPicTotalCurr = 0;
  let sliceTemporalMvpEnabled = false;
  if (nalUnitType !== NAL_IDR_W_RADL && nalUnitType !== NAL_IDR_N_LP) {
    r.bits(sps.log2MaxPicOrderCntLsb); // slice_pic_order_cnt_lsb
    const sets = sps.stRefPicSets;
    let set: StRefPicSet | undefined;
    if (!flag(r)) {
      // short_term_ref_pic_set_sps_flag
      set = parseStRefPicSet(r, sets.length, sets, true);
    } else {
      const index = sets.length > 1 ? inRange(r.bits(log2Ceiling(sets.length)), 0, sets.length - 1, "short_term_ref_pic_set_idx") : 0;
      set = sets[index];
    }
    if (set === undefined) throw new ParseError("slice refers to a reference picture set the sequence does not have");
    for (const used of set.usedByCurrPicS0) if (used) numPicTotalCurr++;
    for (const used of set.usedByCurrPicS1) if (used) numPicTotalCurr++;
    if (sps.longTermRefPicsPresent) {
      const known = sps.usedByCurrPicLtSps.length;
      const fromSps = known > 0 ? inRange(r.ue(), 0, known, "num_long_term_sps") : 0;
      const own = inRange(r.ue(), 0, MAX_LONG_TERM_REF_PIC_SETS - fromSps, "num_long_term_pics");
      for (let i = 0; i < fromSps + own; i++) {
        let used: boolean;
        if (i < fromSps) {
          const index = known > 1 ? inRange(r.bits(log2Ceiling(known)), 0, known - 1, "lt_idx_sps") : 0;
          used = sps.usedByCurrPicLtSps[index]!;
        } else {
          r.bits(sps.log2MaxPicOrderCntLsb); // poc_lsb_lt
          used = flag(r); // used_by_curr_pic_lt_flag
        }
        if (used) numPicTotalCurr++;
        if (flag(r)) r.ue(); // delta_poc_msb_present_flag, delta_poc_msb_cycle_lt
      }
    }
    if (sps.temporalMvpEnabled) sliceTemporalMvpEnabled = flag(r);
  }

  if (sps.sampleAdaptiveOffsetEnabled) {
    r.bit(); // slice_sao_luma_flag
    if (sps.chromaArrayType !== 0) r.bit(); // slice_sao_chroma_flag
  }

  if (sliceType !== SLICE_I) {
    const isB = sliceType === SLICE_B;
    let numRefIdxL0ActiveMinus1 = pps.numRefIdxL0DefaultActiveMinus1;
    let numRefIdxL1ActiveMinus1 = pps.numRefIdxL1DefaultActiveMinus1;
    if (flag(r)) {
      // num_ref_idx_active_override_flag
      numRefIdxL0ActiveMinus1 = inRange(r.ue(), 0, MAX_REF_IDX_ACTIVE - 1, "num_ref_idx_l0_active_minus1");
      if (isB) numRefIdxL1ActiveMinus1 = inRange(r.ue(), 0, MAX_REF_IDX_ACTIVE - 1, "num_ref_idx_l1_active_minus1");
    }
    if (numPicTotalCurr === 0) throw new ParseError("an inter slice with no reference picture");
    if (pps.listsModificationPresent && numPicTotalCurr > 1) {
      // ref_pic_lists_modification
      const entryBits = log2Ceiling(numPicTotalCurr);
      if (flag(r)) for (let i = 0; i <= numRefIdxL0ActiveMinus1; i++) r.bits(entryBits); // list_entry_l0
      if (isB && flag(r)) for (let i = 0; i <= numRefIdxL1ActiveMinus1; i++) r.bits(entryBits); // list_entry_l1
    }
    if (isB) r.bit(); // mvd_l1_zero_flag
    if (pps.cabacInitPresent) r.bit(); // cabac_init_flag
    if (sliceTemporalMvpEnabled) {
      const collocatedFromL0 = isB ? flag(r) : true;
      if ((collocatedFromL0 && numRefIdxL0ActiveMinus1 > 0) || (!collocatedFromL0 && numRefIdxL1ActiveMinus1 > 0)) r.ue(); // collocated_ref_idx
    }
    if ((pps.weightedPred && sliceType === SLICE_P) || (pps.weightedBipred && isB)) {
      const chroma = sps.chromaArrayType !== 0;
      r.ue(); // luma_log2_weight_denom
      if (chroma) r.se(); // delta_chroma_log2_weight_denom
      skipPredWeights(r, numRefIdxL0ActiveMinus1 + 1, chroma);
      if (isB) skipPredWeights(r, numRefIdxL1ActiveMinus1 + 1, chroma);
    }
    r.ue(); // five_minus_max_num_merge_cand
  }

  // SliceQpY, in [-QpBdOffsetY, 51].
  return inRange(26 + pps.initQpMinus26 + r.se(), -sps.qpBdOffsetY, H265_MAX_QP, "slice QP");
}

/**
 * Reads the slice QP of Annex B frames from one encoder. It keeps the parameter sets, which an encoder repeats only
 * with its key frames.
 */
export class H265QuantizerReader {
  private readonly sps = new Map<number, Sps>();
  private readonly pps = new Map<number, Pps>();

  /**
   * The QP of the frame's first slice, or undefined when the frame has none that can be read (not Annex B, a
   * parameter set that was never seen, a syntax this reader does not cover).
   */
  read(frame: Uint8Array): number | undefined {
    const end = frame.length;
    let i = 0;
    // Each NAL unit follows a 00 00 01 start code and has a header of two bytes; the unit ends where the next start
    // code begins.
    while (i + 4 < end) {
      if (frame[i] !== 0 || frame[i + 1] !== 0 || frame[i + 2] !== 1) {
        i++;
        continue;
      }
      const type = (frame[i + 3]! >> 1) & 0x3f;
      const layer = ((frame[i + 3]! & 1) << 5) | (frame[i + 4]! >> 3);
      const start = i + 5;
      // Only the base layer has the syntax read here.
      if (layer !== 0) {
        i = start;
        continue;
      }
      try {
        if (type <= NAL_RASL_R || (type >= NAL_BLA_W_LP && type <= NAL_CRA)) {
          const r = new BitReader(frame, start, end, SLICE_HEADER_BYTES);
          return parseSliceQp(r, type, this.sps, this.pps);
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
