/**
 * The quantizer of an encoded frame as Chrome's encoder would report it (`VideoEncoderOutput::qp`), for the lossiness
 * of `MediaVideoEncoderWrapper::OnEncodedFrame` (media/cast/encoding/media_video_encoder_wrapper.cc). WebCodecs runs
 * the same encoders but passes no quantizer on, so it is read from the frame, per codec:
 *
 * - H.264 and HEVC (hardware): the slice QP over 51 (`VideoEncodeAcceleratorAdapter::BitstreamBufferReady`,
 *   media/video/video_encode_accelerator_adapter.cc).
 * - VP8 and VP9 from libvpx (software): the frame's q index on libvpx's 0 to 63 scale, over 63
 *   (`VpxVideoEncoder::GetEncoderOutput`, media/video/vpx_video_encoder.cc: `VP8E_GET_LAST_QUANTIZER_64` over
 *   `kMaxVpxQuantizer`).
 * - VP8 and VP9 from a hardware encoder: the q index itself, over 127 and 255 (`BitstreamBufferReady` again).
 */
import type { VideoCodec } from "../protocol/constants.ts";
import { H264_MAX_QP, H264QuantizerReader } from "./h264-quantizer.ts";
import { H265_MAX_QP, H265QuantizerReader } from "./h265-quantizer.ts";
import {
  VP8_MAX_Q_INDEX, VP9_MAX_Q_INDEX, VPX_MAX_QUANTIZER, readVp8QIndex, readVp9QIndex, vp8QIndexToQuantizer, vp9QIndexToQuantizer,
} from "./vpx-quantizer.ts";

export interface EncoderQuantizer {
  /** The quantizer on the scale the encoder reports it on. */
  qp: number;
  /** The largest value of that scale, which Chrome divides by. */
  max: number;
  /** `VideoEncoderOutput::qp`: the quantizer in [0, 1]. */
  normalized: number;
}

/** Reads the quantizer of each frame of one encoder; undefined for a frame that has none that can be read. */
export class EncoderQuantizerReader {
  private readonly readFrame: (frame: Uint8Array) => number | undefined;
  private readonly max: number;

  /** A codec Chrome's encoder is not known to report a quantizer for, or no codec, reads nothing. */
  constructor(codec: VideoCodec | undefined, isHardwareEncoder: boolean) {
    this.max = 1;
    this.readFrame = () => undefined;
    if (codec === "h264") {
      const reader = new H264QuantizerReader();
      this.max = H264_MAX_QP;
      this.readFrame = (frame) => reader.read(frame);
    } else if (codec === "hevc") {
      const reader = new H265QuantizerReader();
      this.max = H265_MAX_QP;
      this.readFrame = (frame) => reader.read(frame);
    } else if (codec === "vp8" || codec === "vp9") {
      const readQIndex = codec === "vp8" ? readVp8QIndex : readVp9QIndex;
      if (isHardwareEncoder) {
        this.max = codec === "vp8" ? VP8_MAX_Q_INDEX : VP9_MAX_Q_INDEX;
        this.readFrame = readQIndex;
      } else {
        const toQuantizer = codec === "vp8" ? vp8QIndexToQuantizer : vp9QIndexToQuantizer;
        this.max = VPX_MAX_QUANTIZER;
        this.readFrame = (frame) => {
          const qIndex = readQIndex(frame);
          return qIndex === undefined ? undefined : toQuantizer(qIndex);
        };
      }
    }
  }

  read(frame: Uint8Array): EncoderQuantizer | undefined {
    if (frame.length === 0) return undefined;
    const qp = this.readFrame(frame);
    if (qp === undefined) return undefined;
    return { qp, max: this.max, normalized: Math.min(Math.max(qp / this.max, 0), 1) };
  }
}
