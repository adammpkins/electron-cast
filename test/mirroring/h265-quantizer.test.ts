import { test } from "node:test";
import assert from "node:assert/strict";
import { EncoderQuantizerReader } from "../../src/mirroring/sender/encoder-quantizer.ts";
import { H265QuantizerReader } from "../../src/mirroring/sender/h265-quantizer.ts";
import { BitWriter } from "./bit-writer.ts";

const hex = (s: string) => Uint8Array.from(Buffer.from(s, "hex"));

/**
 * The first bytes of frames a hardware encoder produced (NVIDIA through Media Foundation in Electron 45, Main profile,
 * 1280x720, constant bitrate): an access unit delimiter, then the parameter sets and the IDR slice, or a P slice. The
 * slice QPs are the ones the encoder's rate control chose as the bitrate went from 150 kbps to 30 Mbps, one step a
 * frame from 42 down to 10.
 */
const REAL_KEY = hex(
  "000000014601100000000140010c01ffff01600000030090000003000003005dac090000000142010101600000030090000003000003005da00280802e1f1396b4a421192c2010000003001000000301e080000000014401c1f7c0cc90000000012601af0960f3176ffa119f00609e53",
);
const REAL_DELTA_42 = hex("00000001460130000000010201d008be4106f77ce5b87c1d2ba03a42");
const REAL_DELTA_26 = hex("00000001460130000000010201d350be78a046bb2c2302d6af2a3629");
const REAL_DELTA_10 = hex("00000001460130000000010201d460be410e15a369b74001e76101ee");

test("HEVC quantizer: the slice QP of a hardware encoder's key and delta frames", () => {
  const r = new H265QuantizerReader();
  assert.equal(r.read(REAL_KEY), 35);
  assert.equal(r.read(REAL_DELTA_42), 42);
  assert.equal(r.read(REAL_DELTA_26), 26);
  assert.equal(r.read(REAL_DELTA_10), 10);
});

test("HEVC quantizer: a delta frame cannot be read before the parameter sets of a key frame were seen", () => {
  const r = new H265QuantizerReader();
  assert.equal(r.read(REAL_DELTA_42), undefined);
  assert.equal(r.read(REAL_KEY), 35);
  assert.equal(r.read(REAL_DELTA_42), 42);
});

test("HEVC quantizer: data that is not an Annex B frame, or a slice cut off in its header, has no quantizer", () => {
  const r = new H265QuantizerReader();
  r.read(REAL_KEY);
  assert.equal(r.read(new Uint8Array(0)), undefined);
  assert.equal(r.read(hex("0102030405060708090a")), undefined);
  // A length-prefixed (hvcC) frame has no start codes.
  assert.equal(r.read(hex("0000000c0201d008be4106f77ce5b87c")), undefined);
  assert.equal(r.read(REAL_DELTA_42.subarray(0, 16)), undefined);
});

test("HEVC quantizer: normalized by 51, as VideoEncodeAcceleratorAdapter reports it", () => {
  const r = new EncoderQuantizerReader("hevc", true);
  assert.deepEqual(r.read(REAL_KEY), { qp: 35, max: 51, normalized: 35 / 51 });
  assert.deepEqual(r.read(REAL_DELTA_10), { qp: 10, max: 51, normalized: 10 / 51 });
});

const NAL_TRAIL_R = 1;
const NAL_IDR_W_RADL = 19;
const NAL_CRA = 21;
const NAL_SPS = 33;
const NAL_PPS = 34;
const SLICE_B = 0, SLICE_P = 1, SLICE_I = 2;

/** profile_tier_level: Main profile, level 4, with a profile and a level for each sub-layer below the top one. */
function profileTierLevel(w: BitWriter, maxSubLayersMinus1: number): BitWriter {
  w.u(2, 0).u(1, 0).u(5, 1).u(32, 0x60000000).u(4, 9).u(32, 0).u(11, 0).u(1, 0).u(8, 120);
  for (let i = 0; i < maxSubLayersMinus1; i++) w.u(1, 1).u(1, 1);
  if (maxSubLayersMinus1 > 0) for (let i = maxSubLayersMinus1; i < 8; i++) w.u(2, 0);
  for (let i = 0; i < maxSubLayersMinus1; i++) w.u(32, 0x20000000).u(32, 0).u(24, 0).u(8, 93);
  return w;
}

/** scaling_list_data: most lists copy another; one of each size class past the first is written out. */
function scalingListData(w: BitWriter): BitWriter {
  for (let sizeId = 0; sizeId < 4; sizeId++) {
    for (let matrixId = 0; matrixId < 6; matrixId += sizeId === 3 ? 3 : 1) {
      if (sizeId === 0 || matrixId !== 0) {
        w.u(1, 0).ue(matrixId === 0 ? 0 : 1); // scaling_list_pred_mode_flag, scaling_list_pred_matrix_id_delta
        continue;
      }
      w.u(1, 1);
      if (sizeId > 1) w.se(-3); // scaling_list_dc_coef_minus8
      for (let i = 0; i < 64; i++) w.se((i % 5) - 2);
    }
  }
  return w;
}

/** The plainest sequence: one layer, 8 bit 4:2:0, a picture order count of 8 bits, one reference picture set. */
function plainSps(id: number): number[] {
  const w = profileTierLevel(new BitWriter().u(4, 0).u(3, 0).u(1, 1), 0);
  w.ue(id).ue(1).ue(1280).ue(720).u(1, 0).ue(0).ue(0).ue(4);
  w.u(1, 1).ue(1).ue(0).ue(0); // sps_sub_layer_ordering_info_present_flag and one layer's values
  w.ue(0).ue(2).ue(0).ue(3).ue(1).ue(1); // block and transform sizes
  w.u(1, 0).u(1, 0).u(1, 0).u(1, 0); // no scaling list, AMP, SAO or PCM
  w.ue(1).ue(1).ue(0).ue(0).u(1, 1); // one set: the picture before, used
  w.u(1, 0).u(1, 0).u(1, 1); // no long-term pictures, no temporal MVP, strong intra smoothing
  return w.nalH265(NAL_SPS);
}

const plainPps = (id: number, spsId: number, initQp: number) =>
  new BitWriter().ue(id).ue(spsId).u(1, 0).u(1, 0).u(3, 0).u(1, 0).u(1, 0).ue(0).ue(0).se(initQp - 26)
    .u(1, 0).u(1, 0).u(1, 0).se(0).se(0).u(1, 0).u(1, 0).u(1, 0).u(1, 0).u(1, 0).u(1, 0).u(1, 0).u(1, 0).u(1, 0).u(1, 0).nalH265(NAL_PPS);

test("HEVC quantizer: plain slices, with the QP as the picture's initial QP plus the slice's delta", () => {
  const r = new H265QuantizerReader();
  // IDR: first_slice_segment_in_pic_flag, no_output_of_prior_pics_flag, pps 0, I, slice_qp_delta.
  const idr = new BitWriter().u(1, 1).u(1, 0).ue(0).ue(SLICE_I).se(-4).u(8, 0xaa).nalH265(NAL_IDR_W_RADL);
  assert.equal(r.read(Uint8Array.from([...plainSps(0), ...plainPps(0, 0, 30), ...idr])), 26);
  // P: pps 0, P, slice_pic_order_cnt_lsb, the sequence's reference picture set, no override, merge candidates, delta.
  const p = new BitWriter().u(1, 1).ue(0).ue(SLICE_P).u(8, 1).u(1, 1).u(1, 0).ue(0).se(21).u(8, 0x55).nalH265(NAL_TRAIL_R);
  assert.equal(r.read(Uint8Array.from(p)), 51);
  // A CRA picture is an IRAP picture (no_output_of_prior_pics_flag) that still has a picture order count.
  const cra = new BitWriter().u(1, 1).u(1, 0).ue(0).ue(SLICE_I).u(8, 2).u(1, 1).se(-30).nalH265(NAL_CRA);
  assert.equal(r.read(Uint8Array.from(cra)), 0);
});

/**
 * A sequence that uses the optional syntax: two sub-layers, a scaling list, PCM, SAO, long-term pictures, temporal MVP
 * and three reference picture sets:
 *   0: the pictures at -1 (used) and -3 (not used), and at +2 (used);
 *   1: predicted from set 0 moved by +1, keeping -2 (not used) and the picture set 0 belonged to, at +1 (used);
 *   2: the picture at -1 (used).
 */
function richSps(id: number): number[] {
  const w = profileTierLevel(new BitWriter().u(4, 0).u(3, 1).u(1, 1), 1);
  w.ue(id).ue(1).ue(1920).ue(1088).u(1, 1).ue(0).ue(0).ue(0).ue(4); // with a conformance window
  w.ue(0).ue(0).ue(4);
  w.u(1, 1).ue(3).ue(0).ue(0).ue(4).ue(1).ue(0); // ordering info for both sub-layers
  w.ue(0).ue(3).ue(0).ue(3).ue(2).ue(2);
  scalingListData(w.u(1, 1).u(1, 1)); // scaling_list_enabled_flag, sps_scaling_list_data_present_flag
  w.u(1, 1).u(1, 1); // AMP, SAO
  w.u(1, 1).u(4, 7).u(4, 7).ue(0).ue(2).u(1, 0); // PCM
  w.ue(3);
  w.ue(2).ue(1).ue(0).u(1, 1).ue(1).u(1, 0).ue(1).u(1, 1); // set 0
  // Set 1: inter_ref_pic_set_prediction_flag, delta_rps +1, then for the three pictures of set 0 and for set 0's own
  // picture: used; not used but kept; neither; used.
  w.u(1, 1).u(1, 0).ue(0).u(1, 1).u(1, 0).u(1, 1).u(1, 0).u(1, 0).u(1, 1);
  w.u(1, 0).ue(1).ue(0).ue(0).u(1, 1); // set 2
  w.u(1, 1).ue(2).u(8, 40).u(1, 1).u(8, 80).u(1, 0); // two long-term pictures: used, not used
  w.u(1, 1).u(1, 0); // sps_temporal_mvp_enabled_flag, strong_intra_smoothing_enabled_flag
  return w.nalH265(NAL_SPS);
}

/** A picture parameter set with every part that reaches into the slice header, tiles, deblocking and a scaling list. */
function richPps(id: number, spsId: number): number[] {
  const w = new BitWriter().ue(id).ue(spsId);
  w.u(1, 1).u(1, 1).u(3, 2).u(1, 1).u(1, 1); // dependent slices, output flag, two extra bits, sign hiding, cabac_init
  w.ue(1).ue(0).se(-6); // two references in list 0, one in list 1, init QP 20
  w.u(1, 0).u(1, 1).u(1, 1).ue(1).se(2).se(-2).u(1, 1); // with cu_qp_delta and chroma offsets
  w.u(1, 1).u(1, 0).u(1, 0); // weighted_pred_flag, weighted_bipred_flag, transquant bypass
  w.u(1, 1).u(1, 0).ue(1).ue(1).u(1, 0).ue(9).ue(7).u(1, 1); // tiles: two by two, not uniform
  w.u(1, 1); // pps_loop_filter_across_slices_enabled_flag
  w.u(1, 1).u(1, 1).u(1, 0).se(1).se(-1); // deblocking control with offsets
  scalingListData(w.u(1, 1));
  w.u(1, 1); // lists_modification_present_flag
  return w.nalH265(NAL_PPS);
}

test("HEVC quantizer: the optional parts of a slice header are stepped over", () => {
  const r = new H265QuantizerReader();
  const sets = [...richSps(3), ...richPps(5, 3)];

  // A P slice on set 0 (two pictures used) with two long-term pictures, both used: four references in all.
  const p = new BitWriter().u(1, 1).ue(5).u(2, 0).ue(SLICE_P).u(1, 1); // extra bits, type, pic_output_flag
  p.u(8, 9).u(1, 1).u(2, 0); // slice_pic_order_cnt_lsb, short_term_ref_pic_set_sps_flag, set 0 of three
  p.ue(1).ue(1); // num_long_term_sps, num_long_term_pics
  p.u(1, 0).u(1, 0); // lt_idx_sps 0 (used), no delta_poc_msb
  p.u(8, 200).u(1, 1).u(1, 1).ue(2); // poc_lsb_lt, used_by_curr_pic_lt_flag, delta_poc_msb_cycle_lt
  p.u(1, 1); // slice_temporal_mvp_enabled_flag
  p.u(1, 1).u(1, 0); // SAO luma and chroma
  p.u(1, 1).ue(2); // num_ref_idx_active_override_flag: three references
  p.u(1, 1).u(2, 3).u(2, 0).u(2, 1); // list 0 modified: three entries of two bits
  p.u(1, 1); // cabac_init_flag
  p.ue(1); // collocated_ref_idx
  p.ue(3).se(-1); // pred_weight_table: the denominators
  p.u(1, 1).u(1, 0).u(1, 1); // luma weights for references 0 and 2
  p.u(1, 0).u(1, 1).u(1, 1); // chroma weights for references 1 and 2
  p.se(5).se(-5); // reference 0: luma
  p.se(1).se(2).se(3).se(4); // reference 1: chroma
  p.se(-7).se(7).se(-1).se(-2).se(-3).se(-4); // reference 2: both
  p.ue(2); // five_minus_max_num_merge_cand
  p.se(17); // slice_qp_delta
  assert.equal(r.read(Uint8Array.from([...sets, ...p.u(8, 0xee).nalH265(NAL_TRAIL_R)])), 37);

  // A P slice on the predicted set 1: only its picture at +1 is used, so one reference and no list modification.
  const one = new BitWriter().u(1, 1).ue(5).u(2, 3).ue(SLICE_P).u(1, 1).u(8, 10).u(1, 1).u(2, 1);
  one.ue(0).ue(0).u(1, 0); // no long-term pictures, no temporal MVP for the slice
  one.u(1, 0).u(1, 0).u(1, 0); // SAO off, no override: two references by default
  one.u(1, 0); // cabac_init_flag
  one.ue(0).se(0).u(1, 0).u(1, 0).u(1, 0).u(1, 0); // weights: denominators, no flags set
  one.ue(0).se(-9);
  assert.equal(r.read(Uint8Array.from(one.u(8, 0xee).nalH265(NAL_TRAIL_R))), 11);

  // A B slice with a reference picture set of its own, predicted from set 2 moved by -1: the picture set 2 belonged
  // to (not used) and the one at -2 (used). One reference, so no list modification; no weights for B slices here.
  const b = new BitWriter().u(1, 1).ue(5).u(2, 0).ue(SLICE_B).u(1, 0).u(8, 11).u(1, 0);
  b.u(1, 1).ue(0).u(1, 1).ue(0).u(1, 1).u(1, 0).u(1, 1); // prediction flag, delta_idx_minus1, delta_rps -1, the flags
  b.ue(0).ue(0).u(1, 1); // no long-term pictures, temporal MVP for the slice
  b.u(1, 1).u(1, 1).u(1, 0); // SAO, no override
  b.u(1, 1).u(1, 0); // mvd_l1_zero_flag, cabac_init_flag
  b.u(1, 1).ue(1); // collocated_from_l0_flag, collocated_ref_idx (list 0 has two entries)
  b.ue(4).se(-2);
  assert.equal(r.read(Uint8Array.from(b.u(8, 0xee).nalH265(NAL_TRAIL_R))), 18);

  // The same with the collocated picture in list 1, which has one entry: no collocated_ref_idx.
  const b1 = new BitWriter().u(1, 1).ue(5).u(2, 0).ue(SLICE_B).u(1, 0).u(8, 12).u(1, 1).u(2, 2);
  b1.ue(0).ue(0).u(1, 1).u(1, 0).u(1, 0).u(1, 0).u(1, 0).u(1, 0).u(1, 0).ue(0).se(31);
  assert.equal(r.read(Uint8Array.from(b1.u(8, 0xee).nalH265(NAL_TRAIL_R))), 51);
});

test("HEVC quantizer: emulation prevention bytes are not part of the syntax", () => {
  // The profile and level of a real sequence parameter set are full of zero bytes, carried as 00 00 03.
  assert.ok(Buffer.from(REAL_KEY).includes(Buffer.from([0, 0, 3])), "the parameter sets have emulation prevention bytes");
  assert.equal(new H265QuantizerReader().read(REAL_KEY), 35);
  // With those bytes read as data the set means something else, and the slice after it cannot be read as it was.
  const kept = Buffer.from(REAL_KEY).toString("hex").replaceAll("000003", "0000ff");
  assert.notEqual(new H265QuantizerReader().read(hex(kept)), 35);
});

test("HEVC quantizer: a slice of an unknown parameter set, a later slice segment, another layer, or a QP out of range has no quantizer", () => {
  const r = new H265QuantizerReader();
  r.read(Uint8Array.from([...plainSps(0), ...plainPps(0, 0, 26)]));
  const idr = (pps: number, delta: number, first = 1, layer = 0) =>
    Uint8Array.from(new BitWriter().u(1, first).u(1, 0).ue(pps).ue(SLICE_I).se(delta).u(8, 0xaa).nalH265(NAL_IDR_W_RADL, layer));
  assert.equal(r.read(idr(0, 3)), 29);
  assert.equal(r.read(idr(7, 3)), undefined);
  assert.equal(r.read(idr(0, 3, 0)), undefined);
  assert.equal(r.read(idr(0, 3, 1, 1)), undefined);
  assert.equal(r.read(idr(0, 26)), undefined);
  assert.equal(r.read(idr(0, -27)), undefined);
  // An inter slice whose reference picture set uses no picture is not a slice an encoder writes.
  const sps = profileTierLevel(new BitWriter().u(4, 0).u(3, 0).u(1, 1), 0);
  sps.ue(1).ue(1).ue(1280).ue(720).u(1, 0).ue(0).ue(0).ue(4).u(1, 1).ue(1).ue(0).ue(0).ue(0).ue(2).ue(0).ue(3).ue(1).ue(1);
  sps.u(1, 0).u(1, 0).u(1, 0).u(1, 0).ue(1).ue(1).ue(0).ue(0).u(1, 0).u(1, 0).u(1, 0).u(1, 1);
  r.read(Uint8Array.from([...sps.nalH265(NAL_SPS), ...plainPps(1, 1, 26)]));
  const p = new BitWriter().u(1, 1).ue(1).ue(SLICE_P).u(8, 1).u(1, 1).u(1, 0).ue(0).se(1).nalH265(NAL_TRAIL_R);
  assert.equal(r.read(Uint8Array.from(p)), undefined);
});

test("HEVC quantizer: 10 bit video may have a slice QP below zero, which is reported as no less than zero", () => {
  const w = profileTierLevel(new BitWriter().u(4, 0).u(3, 0).u(1, 1), 0);
  w.ue(0).ue(1).ue(1280).ue(720).u(1, 0).ue(2).ue(2).ue(4).u(1, 1).ue(1).ue(0).ue(0).ue(0).ue(2).ue(0).ue(3).ue(1).ue(1);
  w.u(1, 0).u(1, 0).u(1, 0).u(1, 0).ue(0).u(1, 0).u(1, 0).u(1, 1);
  const idr = (delta: number) => new BitWriter().u(1, 1).u(1, 0).ue(0).ue(SLICE_I).se(delta).u(8, 0xaa).nalH265(NAL_IDR_W_RADL);
  const r = new EncoderQuantizerReader("hevc", true);
  assert.deepEqual(r.read(Uint8Array.from([...w.nalH265(NAL_SPS), ...plainPps(0, 0, 26), ...idr(-30)])), { qp: -4, max: 51, normalized: 0 });
  assert.equal(r.read(Uint8Array.from(idr(-39))), undefined);
});
