import { test } from "node:test";
import assert from "node:assert/strict";
import { EncoderQuantizerReader } from "../../src/mirroring/sender/encoder-quantizer.ts";
import { readVp8QIndex, readVp9QIndex, vp8QIndexToQuantizer, vp9QIndexToQuantizer } from "../../src/mirroring/sender/vpx-quantizer.ts";
import { BitWriter } from "./bit-writer.ts";

const hex = (s: string) => Uint8Array.from(Buffer.from(s, "hex"));

/**
 * The first bytes of frames Chrome's software encoders produced (libvpx through WebCodecs in Electron 45, 1280x720,
 * constant bitrate, realtime): 150 kbps for the first frames, which pins the encoder at the largest quantizer Chrome
 * allows it (`rc_max_quantizer` 58 in media/video/vpx_video_encoder.cc), then 30 Mbps, which lets it fall to the
 * smallest (12 for VP8 screen content, 2 for VP9).
 */
const VP8_KEY_Q58 = hex("90be059d012a0005d0023971002a1c22161622661220e03fffac1ff7fdcfeb57");
const VP8_DELTA_Q58 = hex("711601e4f87fe8cec673fbe05e30225ffdffbd1cafe6ffc7");
const VP8_DELTA_Q42 = hex("d1fe00e439ffe8cec3799b235c5567e7ff0dcec3fe27f76f");
const VP8_DELTA_Q12 = hex("91f100e37b7fe830006e206ea6bd9fd4de9e38081a6cb2dd");
const VP9_KEY_Q58 = hex("82498342404ff02cf67e38241c19d01803945f57fe6fc3ff3fedafb81ff86ff2");
const VP9_DELTA_Q58 = hex("8600409273c1740dfec040580c07ef3380c13c8a6c000006");
const VP9_DELTA_Q33 = hex("8600c092f12140860057769fdccc5ca6f6dee3b799372f74");
const VP9_DELTA_Q2 = hex("8600c092f0510406003276a81cf9bdb61edfe17e5e05fc9e");

test("VP8 quantizer: the q index of a software encoder's key and delta frames, at Chrome's largest and smallest quantizers", () => {
  assert.equal(readVp8QIndex(VP8_KEY_Q58), 112);
  assert.equal(readVp8QIndex(VP8_DELTA_Q58), 112);
  assert.equal(readVp8QIndex(VP8_DELTA_Q42), 64);
  assert.equal(readVp8QIndex(VP8_DELTA_Q12), 15);
});

test("VP8 quantizer: libvpx reports the q index on its 0 to 63 scale (vp8_reverse_trans)", () => {
  assert.equal(vp8QIndexToQuantizer(112), 58);
  assert.equal(vp8QIndexToQuantizer(64), 42);
  assert.equal(vp8QIndexToQuantizer(15), 12);
  assert.equal(vp8QIndexToQuantizer(0), 0);
  assert.equal(vp8QIndexToQuantizer(127), 63);
  // A q index between two entries of the table is the quantizer of the next one up.
  assert.equal(vp8QIndexToQuantizer(6), 6);
  assert.equal(vp8QIndexToQuantizer(11), 10);
  assert.equal(vp8QIndexToQuantizer(62), 42);
  assert.equal(vp8QIndexToQuantizer(200), 63);
});

/** The boolean entropy encoder of RFC 6386 section 7.3, for hand-built VP8 headers. */
class BoolEncoder {
  private readonly out: number[] = [];
  private range = 255;
  private bottom = 0;
  private bitCount = 24;

  private bool(probability: number, bit: number): void {
    const split = 1 + (((this.range - 1) * probability) >> 8);
    if (bit) {
      this.bottom = (this.bottom + split) >>> 0;
      this.range -= split;
    } else {
      this.range = split;
    }
    while (this.range < 128) {
      this.range <<= 1;
      if (this.bottom >= 2 ** 31) {
        let i = this.out.length - 1;
        while (this.out[i] === 255) this.out[i--] = 0;
        this.out[i]!++;
      }
      this.bottom = (this.bottom * 2) % 2 ** 32;
      if (--this.bitCount === 0) {
        this.out.push(Math.floor(this.bottom / 2 ** 24));
        this.bottom %= 2 ** 24;
        this.bitCount = 8;
      }
    }
  }

  /** L(n). */
  l(bits: number, value: number): this {
    for (let i = bits - 1; i >= 0; i--) this.bool(128, (value >> i) & 1);
    return this;
  }

  /** The partition: what was written, then enough zero bits to push it all out. */
  bytes(): number[] {
    this.l(16, 0).l(16, 0);
    return [...this.out, 0, 0];
  }
}

const VP8_KEY_TAG = [0x10, 0x00, 0x00, 0x9d, 0x01, 0x2a, 0x00, 0x05, 0xd0, 0x02];
const VP8_DELTA_TAG = [0x11, 0x00, 0x00];

test("VP8 quantizer: the optional parts of the frame header are stepped over", () => {
  // A key frame: colour space and clamping, no segmentation, a plain loop filter, one partition, then y_ac_qi.
  const plain = new BoolEncoder().l(2, 0).l(1, 0).l(1, 0).l(6, 20).l(3, 2).l(1, 0).l(2, 0).l(7, 77);
  assert.equal(readVp8QIndex(Uint8Array.from([...VP8_KEY_TAG, ...plain.bytes()])), 77);

  // A delta frame with segmentation: a new map and new feature data, with some quantizers, filter levels and
  // probabilities present; loop filter deltas for two reference frames and one mode.
  const w = new BoolEncoder();
  w.l(1, 1).l(1, 1).l(1, 1); // segmentation_enabled, update_mb_segmentation_map, update_segment_feature_data
  w.l(1, 1); // segment_feature_mode
  w.l(1, 1).l(7, 100).l(1, 1).l(1, 0).l(1, 1).l(7, 5).l(1, 0).l(1, 0); // quantizer updates: two of four
  w.l(1, 0).l(1, 1).l(6, 63).l(1, 1).l(1, 0).l(1, 0); // loop filter updates: one of four
  w.l(1, 1).l(8, 200).l(1, 0).l(1, 1).l(8, 3); // segment probabilities: two of three
  w.l(1, 1).l(6, 63).l(3, 7); // filter type, level, sharpness
  w.l(1, 1).l(1, 1); // loop_filter_adj_enable, mode_ref_lf_delta_update
  w.l(1, 1).l(6, 9).l(1, 1).l(1, 0).l(1, 1).l(6, 1).l(1, 0).l(1, 0); // reference frame deltas
  w.l(1, 0).l(1, 0).l(1, 1).l(6, 33).l(1, 0).l(1, 0); // mode deltas
  w.l(2, 3); // log2_nbr_of_dct_partitions
  w.l(7, 127); // y_ac_qi
  assert.equal(readVp8QIndex(Uint8Array.from([...VP8_DELTA_TAG, ...w.bytes()])), 127);

  // Segmentation that changes nothing, and loop filter adjustments without an update.
  const quiet = new BoolEncoder().l(1, 1).l(1, 0).l(1, 0).l(10, 0).l(1, 1).l(1, 0).l(2, 1).l(7, 3);
  assert.equal(readVp8QIndex(Uint8Array.from([...VP8_DELTA_TAG, ...quiet.bytes()])), 3);
});

test("VP8 quantizer: data that is not a VP8 frame, or one cut off in its header, has no quantizer", () => {
  assert.equal(readVp8QIndex(new Uint8Array(0)), undefined);
  assert.equal(readVp8QIndex(hex("9000")), undefined);
  // A key frame without its start code (here: the start of an H.264 frame).
  assert.equal(readVp8QIndex(hex("0000000109100000000167640028ac2b")), undefined);
  assert.equal(readVp8QIndex(VP8_KEY_Q58.subarray(0, 11)), undefined);
  assert.equal(readVp8QIndex(VP8_DELTA_Q58.subarray(0, 4)), undefined);
});

test("VP9 quantizer: the q index of a software encoder's key and delta frames, at Chrome's largest and smallest quantizers", () => {
  assert.equal(readVp9QIndex(VP9_KEY_Q58), 232);
  assert.equal(readVp9QIndex(VP9_DELTA_Q58), 232);
  assert.equal(readVp9QIndex(VP9_DELTA_Q33), 129);
  assert.equal(readVp9QIndex(VP9_DELTA_Q2), 8);
});

test("VP9 quantizer: libvpx reports the q index on its 0 to 63 scale (vp9_qindex_to_quantizer)", () => {
  assert.equal(vp9QIndexToQuantizer(232), 58);
  assert.equal(vp9QIndexToQuantizer(129), 33);
  assert.equal(vp9QIndexToQuantizer(8), 2);
  assert.equal(vp9QIndexToQuantizer(0), 0);
  assert.equal(vp9QIndexToQuantizer(255), 63);
  assert.equal(vp9QIndexToQuantizer(244), 61);
  assert.equal(vp9QIndexToQuantizer(245), 62);
  assert.equal(vp9QIndexToQuantizer(250), 63);
});

const SYNC = 0x498342;
/** frame_marker, the profile's two bits (low first), and show_existing_frame. */
const vp9Start = (profile = 0, showExisting = 0) => {
  const w = new BitWriter().u(2, 2).u(1, profile & 1).u(1, profile >> 1);
  if (profile === 3) w.u(1, 0);
  return w.u(1, showExisting);
};
/** refresh_frame_context, frame_parallel_decoding_mode, frame_context_idx, a plain loop filter, then base_q_idx. */
const vp9End = (w: BitWriter, q: number) => w.u(2, 1).u(2, 0).u(6, 12).u(3, 0).u(1, 0).u(8, q).u(16, 0xffff).bytes();

test("VP9 quantizer: key, inter and intra-only headers, with their optional parts stepped over", () => {
  // A key frame: frame_type 0, show_frame, no error resilience, sync code, BT.709 with its range, the size, a render
  // size of its own.
  const key = vp9Start().u(1, 0).u(1, 1).u(1, 0).u(24, SYNC).u(3, 2).u(1, 0).u(16, 1279).u(16, 719).u(1, 1).u(16, 639).u(16, 359);
  assert.equal(readVp9QIndex(Uint8Array.from(vp9End(key, 201))), 201);

  // An inter frame whose size is the third reference's, with a fixed interpolation filter and loop filter deltas.
  const inter = vp9Start().u(1, 1).u(1, 1).u(1, 0).u(2, 0).u(8, 1).u(12, 0x123);
  inter.u(1, 0).u(1, 0).u(1, 1); // found_ref on the third
  inter.u(1, 0); // render_and_frame_size_different
  inter.u(1, 1).u(1, 0).u(2, 3); // allow_high_precision_mv, a filter that is not switchable
  inter.u(2, 3).u(2, 1).u(6, 30).u(3, 4); // context flags and index, loop filter level and sharpness
  inter.u(1, 1).u(1, 1); // loop_filter_delta_enabled, loop_filter_delta_update
  inter.u(1, 1).u(7, 0x41).u(1, 0).u(1, 1).u(7, 3).u(1, 0); // reference deltas
  inter.u(1, 0).u(1, 1).u(7, 0x7f); // mode deltas
  assert.equal(readVp9QIndex(Uint8Array.from(inter.u(8, 99).u(16, 0).bytes())), 99);

  // An inter frame with no reference of its size: the size is in the header. Switchable filter.
  const sized = vp9Start().u(1, 1).u(1, 1).u(1, 0).u(2, 0).u(8, 2).u(12, 0).u(3, 0).u(16, 799).u(16, 449).u(1, 0).u(1, 0).u(1, 1);
  assert.equal(readVp9QIndex(Uint8Array.from(vp9End(sized, 17))), 17);

  // An error resilient inter frame has neither reset_frame_context nor the two context flags.
  const resilient = vp9Start().u(1, 1).u(1, 1).u(1, 1).u(8, 1).u(12, 0).u(1, 1).u(1, 0).u(1, 0).u(1, 1);
  assert.equal(readVp9QIndex(Uint8Array.from(resilient.u(2, 0).u(6, 1).u(3, 0).u(1, 0).u(8, 250).u(16, 0).bytes())), 250);

  // An intra-only frame (not shown) of profile 0 has no colour configuration.
  const intraOnly = vp9Start().u(1, 1).u(1, 0).u(1, 0).u(1, 1).u(2, 0).u(24, SYNC).u(8, 0xff).u(16, 319).u(16, 179).u(1, 0);
  assert.equal(readVp9QIndex(Uint8Array.from(vp9End(intraOnly, 64))), 64);

  // Profile 2 has a bit depth, in an intra-only frame too; profile 1 has its subsampling, or RGB with a reserved bit.
  const deep = vp9Start(2).u(1, 1).u(1, 0).u(1, 0).u(1, 1).u(2, 0).u(24, SYNC).u(1, 1).u(3, 5).u(1, 1).u(8, 1).u(16, 319).u(16, 179).u(1, 0);
  assert.equal(readVp9QIndex(Uint8Array.from(vp9End(deep, 65))), 65);
  const profile1 = vp9Start(1).u(1, 0).u(1, 1).u(1, 0).u(24, SYNC).u(3, 2).u(1, 0).u(3, 0).u(16, 319).u(16, 179).u(1, 0);
  assert.equal(readVp9QIndex(Uint8Array.from(vp9End(profile1, 66))), 66);
  const rgb = vp9Start(1).u(1, 0).u(1, 1).u(1, 0).u(24, SYNC).u(3, 7).u(1, 0).u(16, 319).u(16, 179).u(1, 0);
  assert.equal(readVp9QIndex(Uint8Array.from(vp9End(rgb, 67))), 67);
  const profile3 = vp9Start(3).u(1, 0).u(1, 1).u(1, 0).u(24, SYNC).u(1, 0).u(3, 2).u(1, 0).u(3, 0).u(16, 319).u(16, 179).u(1, 0);
  assert.equal(readVp9QIndex(Uint8Array.from(vp9End(profile3, 68))), 68);
});

/** A superframe: the frames, then an index of their sizes between two marker bytes (VP9 Annex B). */
function superframe(frames: number[][], sizeBytes = 2): Uint8Array {
  const marker = 0xc0 | ((sizeBytes - 1) << 3) | (frames.length - 1);
  const index = [marker];
  for (const f of frames) for (let b = 0; b < sizeBytes; b++) index.push(Math.floor(f.length / 2 ** (8 * b)) % 256);
  return Uint8Array.from([...frames.flat(), ...index, marker]);
}

test("VP9 quantizer: a frame that shows an earlier one has no quantizer, and a superframe gives that of its last coded frame", () => {
  const shown = vp9Start(0, 1).u(3, 2).bytes();
  assert.equal(readVp9QIndex(Uint8Array.from(shown)), undefined);
  const frame = (q: number) => vp9End(vp9Start().u(1, 1).u(1, 0).u(1, 0).u(1, 0).u(2, 0).u(8, 1).u(12, 0).u(1, 1).u(1, 0).u(1, 0).u(1, 1), q);
  assert.equal(readVp9QIndex(superframe([frame(40), frame(90)])), 90);
  assert.equal(readVp9QIndex(superframe([frame(200), shown])), 200);
  assert.equal(readVp9QIndex(superframe([frame(40), frame(41), frame(42)], 1)), 42);
  // An index that does not fit the chunk: the marker byte was the last byte of a single frame's data.
  const single = Uint8Array.from([...frame(77).slice(0, 12), 0xc1]);
  assert.equal(readVp9QIndex(single), 77);
  // An index that points past the frames.
  const bad = superframe([frame(40), frame(90)]);
  bad[bad.length - 2] = 0xff;
  assert.equal(readVp9QIndex(bad), undefined);
});

test("VP9 quantizer: data that is not a VP9 frame, or one cut off in its header, has no quantizer", () => {
  assert.equal(readVp9QIndex(new Uint8Array(0)), undefined);
  assert.equal(readVp9QIndex(hex("0000000109100000000167640028ac2b")), undefined);
  assert.equal(readVp9QIndex(VP9_KEY_Q58.subarray(0, 9)), undefined);
  // A key frame with a wrong sync code.
  assert.equal(readVp9QIndex(hex("82498343404ff02cf67e38241c19d018")), undefined);
});

test("encoder quantizer: a software VP8 or VP9 frame is normalized over 63 as VpxVideoEncoder reports it, a hardware one by its q index", () => {
  const softwareVp8 = new EncoderQuantizerReader("vp8", false);
  assert.deepEqual(softwareVp8.read(VP8_KEY_Q58), { qp: 58, max: 63, normalized: 58 / 63 });
  assert.deepEqual(softwareVp8.read(VP8_DELTA_Q12), { qp: 12, max: 63, normalized: 12 / 63 });
  const softwareVp9 = new EncoderQuantizerReader("vp9", false);
  assert.deepEqual(softwareVp9.read(VP9_DELTA_Q33), { qp: 33, max: 63, normalized: 33 / 63 });
  // VideoEncodeAcceleratorAdapter::BitstreamBufferReady: 127 for VP8, 255 for VP9.
  assert.deepEqual(new EncoderQuantizerReader("vp8", true).read(VP8_KEY_Q58), { qp: 112, max: 127, normalized: 112 / 127 });
  assert.deepEqual(new EncoderQuantizerReader("vp9", true).read(VP9_KEY_Q58), { qp: 232, max: 255, normalized: 232 / 255 });
  // No frame, a frame that cannot be read, and a codec no quantizer is read for.
  assert.equal(softwareVp8.read(new Uint8Array(0)), undefined);
  assert.equal(softwareVp8.read(hex("0000000109100000000167640028ac2b")), undefined);
  assert.equal(new EncoderQuantizerReader("av1", false).read(VP9_KEY_Q58), undefined);
  assert.equal(new EncoderQuantizerReader(undefined, false).read(VP8_KEY_Q58), undefined);
});
