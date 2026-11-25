import { test } from "node:test";
import assert from "node:assert/strict";
import { H264QuantizerReader, normalizedH264Quantizer } from "../../src/mirroring/sender/h264-quantizer.ts";
import { BitWriter } from "./bit-writer.ts";

const hex = (s: string) => Uint8Array.from(Buffer.from(s, "hex"));

/**
 * The first bytes of frames a hardware encoder produced (NVIDIA through Media Foundation in Electron 45, High profile,
 * CABAC, 1888x1062, constant bitrate): an access unit delimiter, then the parameter sets and the IDR slice, or a P
 * slice. The slice QPs are the ones the encoder's rate control chose as the bitrate went from 2 to 8 Mbps.
 */
const REAL_KEY = hex("0000000109100000000167640028ac2b403b010ff36022000007d00001d4c01e3855400000000168ee3cb00000000165b804087f0b6e47ffbaa0ad8955fd4c73");
const REAL_DELTA_33 = hex("0000000109300000000161e0223bfffe9da8fd4bffffc3e7");
const REAL_DELTA_32 = hex("0000000109300000000161e04233fffe9da525156d077fff");
const REAL_DELTA_51 = hex("0000000109300000000161e0220cbffee8c20b63fff06654");

test("H.264 quantizer: the slice QP of a hardware encoder's key and delta frames", () => {
  const r = new H264QuantizerReader();
  assert.equal(r.read(REAL_KEY), 34);
  assert.equal(r.read(REAL_DELTA_33), 33);
  assert.equal(r.read(REAL_DELTA_32), 32);
  assert.equal(r.read(REAL_DELTA_51), 51);
});

test("H.264 quantizer: a delta frame cannot be read before the parameter sets of a key frame were seen", () => {
  const r = new H264QuantizerReader();
  assert.equal(r.read(REAL_DELTA_33), undefined);
  assert.equal(r.read(REAL_KEY), 34);
  assert.equal(r.read(REAL_DELTA_33), 33);
});

test("H.264 quantizer: data that is not an Annex B frame has no quantizer", () => {
  const r = new H264QuantizerReader();
  r.read(REAL_KEY);
  assert.equal(r.read(new Uint8Array(0)), undefined);
  assert.equal(r.read(hex("0102030405060708090a")), undefined);
  // An AVC (length-prefixed) frame has no start codes.
  assert.equal(r.read(hex("0000000c61e0223bfffe9da8fd4bffff")), undefined);
  // A slice cut off inside its header.
  assert.equal(r.read(REAL_DELTA_33.subarray(0, 13)), undefined);
});

/** A Baseline SPS (no chroma format fields): picture order count type 2, frames only. */
const baselineSps = (id: number) =>
  new BitWriter().u(8, 66).u(16, 0xc01f).ue(id).ue(0 /* log2_max_frame_num_minus4 */).ue(2).ue(1).u(1, 0).ue(79).ue(44).u(1, 1).nal(3, 7);

/** A High SPS with scaling lists, picture order count type 0 (8 bit lsb), 6 bit frame numbers, fields allowed. */
function highSps(id: number): number[] {
  const w = new BitWriter().u(8, 100).u(16, 0x0028).ue(id).ue(1).ue(0).ue(0).u(1, 0);
  w.u(1, 1); // seq_scaling_matrix_present_flag
  // the first list is present with two deltas, the second of which ends it; the other seven are absent
  w.u(1, 1).se(-2).se(-6);
  for (let i = 1; i < 8; i++) w.u(1, 0);
  return w.ue(2).ue(0).ue(4).ue(2).u(1, 0).ue(119).ue(67).u(1, 0).nal(3, 7);
}

interface PpsOptions { cabac?: boolean; weighted?: boolean; initQp?: number; redundant?: boolean; bottomField?: boolean; refs?: number }
const pps = (id: number, spsId: number, o: PpsOptions = {}) =>
  new BitWriter().ue(id).ue(spsId).u(1, o.cabac ? 1 : 0).u(1, o.bottomField ? 1 : 0).ue(0).ue(o.refs ?? 0).ue(0)
    .u(1, o.weighted ? 1 : 0).u(2, 0).se((o.initQp ?? 26) - 26).se(0).se(0).u(1, 1).u(1, 0).u(1, o.redundant ? 1 : 0).nal(3, 8);

test("H.264 quantizer: Baseline slices, with the QP as the picture's initial QP plus the slice's delta", () => {
  const r = new H264QuantizerReader();
  // IDR: first_mb 0, slice_type 7 (I), pps 0, frame_num (4 bits), idr_pic_id, dec_ref_pic_marking (2 flags), slice_qp_delta.
  const idr = new BitWriter().ue(0).ue(7).ue(0).u(4, 0).ue(3).u(2, 0).se(-4).u(8, 0xaa).nal(3, 5);
  assert.equal(r.read(Uint8Array.from([...baselineSps(0), ...pps(0, 0, { initQp: 30 }), ...idr])), 26);
  // P: slice_type 5, frame_num, no override, no list modification, no adaptive marking, slice_qp_delta.
  const p = new BitWriter().ue(0).ue(5).ue(0).u(4, 1).u(1, 0).u(1, 0).u(1, 0).se(21).u(8, 0x55).nal(2, 1);
  assert.equal(r.read(Uint8Array.from(p)), 51);
  // A non-reference P slice has no dec_ref_pic_marking.
  const unreferenced = new BitWriter().ue(0).ue(0).ue(0).u(4, 2).u(1, 0).u(1, 0).se(-30).nal(0, 1);
  assert.equal(r.read(Uint8Array.from(unreferenced)), 0);
});

test("H.264 quantizer: the optional parts of a slice header are stepped over", () => {
  const r = new H264QuantizerReader();
  const sets = [...highSps(1), ...pps(2, 1, { cabac: true, weighted: true, initQp: 20, redundant: true, bottomField: true, refs: 1 })];
  const w = new BitWriter().ue(0).ue(0).ue(2); // first_mb, P, pps 2
  w.u(6, 5); // frame_num
  w.u(1, 0); // field_pic_flag
  w.u(8, 9).se(1); // pic_order_cnt_lsb, delta_pic_order_cnt_bottom
  w.ue(0); // redundant_pic_cnt
  w.u(1, 1).ue(2); // num_ref_idx_active_override_flag: three references
  w.u(1, 1).ue(0).ue(4).ue(2).ue(1).ue(3); // ref_pic_list_modification: two entries, then the end
  w.ue(2).ue(1); // pred_weight_table: the denominators
  w.u(1, 1).se(3).se(-1).u(1, 1).se(1).se(2).se(3).se(4); // reference 0: luma and chroma weights
  w.u(1, 0).u(1, 0); // reference 1: none
  w.u(1, 1).se(-5).se(5).u(1, 0); // reference 2: luma only
  w.u(1, 1).ue(1).ue(0).ue(3).ue(2).ue(1).ue(4).ue(1).ue(0); // dec_ref_pic_marking: operations 1, 3, 4, then the end
  w.ue(1); // cabac_init_idc
  w.se(17); // slice_qp_delta
  assert.equal(r.read(Uint8Array.from([...sets, ...w.nal(2, 1)])), 37);

  // A B slice has a second list and no explicit weights with weighted_bipred_idc 0.
  const b = new BitWriter().ue(0).ue(1).ue(2).u(6, 6).u(1, 0).u(8, 10).se(0).ue(0).u(1, 1).u(1, 0).u(1, 0).u(1, 0).ue(0).se(-2).nal(0, 1);
  assert.equal(r.read(Uint8Array.from(b)), 18);
});

test("H.264 quantizer: emulation prevention bytes are not part of the syntax", () => {
  const r = new H264QuantizerReader();
  // A 16 bit frame number and a 16 bit picture order count of zero are zero bytes, which the bitstream carries as 00 00 03.
  const sps = new BitWriter().u(8, 66).u(16, 0xc01f).ue(0).ue(12).ue(0).ue(12).ue(1).u(1, 0).ue(79).ue(44).u(1, 1).nal(3, 7);
  const real = new BitWriter().ue(0).ue(7).ue(0).u(16, 0).u(16, 0).se(9).nal(0, 1);
  assert.ok(Buffer.from(real).includes(Buffer.from([0, 0, 3])), "the test frame has an emulation prevention byte");
  assert.equal(r.read(Uint8Array.from([...sps, ...pps(0, 0), ...real])), 35);
});

test("H.264 quantizer: a slice that names an unknown parameter set, or a QP out of range, has no quantizer", () => {
  const r = new H264QuantizerReader();
  r.read(Uint8Array.from([...baselineSps(0), ...pps(0, 0)]));
  const unknownPps = new BitWriter().ue(0).ue(7).ue(5).u(4, 0).se(0).nal(0, 1);
  assert.equal(r.read(Uint8Array.from(unknownPps)), undefined);
  const outOfRange = new BitWriter().ue(0).ue(7).ue(0).u(4, 0).se(40).nal(0, 1);
  assert.equal(r.read(Uint8Array.from(outOfRange)), undefined);
});

test("H.264 quantizer: normalized by the largest QP, as VideoEncodeAcceleratorAdapter reports it", () => {
  assert.equal(normalizedH264Quantizer(51), 1);
  assert.equal(normalizedH264Quantizer(0), 0);
  assert.ok(Math.abs(normalizedH264Quantizer(35) - 35 / 51) < 1e-12);
  assert.equal(normalizedH264Quantizer(60), 1);
});
