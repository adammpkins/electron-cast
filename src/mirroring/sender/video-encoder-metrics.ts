/**
 * What `MediaVideoEncoderWrapper` (media/cast/encoding/media_video_encoder_wrapper.cc) reports about each encoded
 * frame besides its bytes: the encoder utilization (`CalculateEncoderUtilization`, `ComputeAndRecordUtilization`) and
 * the lossiness (`ComputeLossiness`). `VideoSender` takes the larger of the two as the resource utilization it
 * reports to the capture side (see video-sender.ts).
 */

/** Utilization of the encoder is clamped to [0, 2] so an anomaly (system sleep, a starved thread) cannot swamp feedback. */
export const MAX_ENCODER_UTILIZATION = 2;
/** `kPipelineSize` and `kMaxBacklogSize` of the hardware model. */
const PIPELINE_SIZE = 3;
const MAX_BACKLOG_SIZE = PIPELINE_SIZE + 1;
/** `kEmaWeight`: the weight of the newest utilization, which smooths out key frame spikes. */
export const UTILIZATION_EMA_WEIGHT = 0.1;
/** `kMaxLossiness`. */
export const MAX_LOSSINESS = 5.0;

/**
 * `CalculateEncoderUtilization`. A hardware encoder is pipelined, so its utilization is the worse of the backlog
 * (frames submitted and not yet finished, this one included) and the latency over a pipeline of frames; a software
 * encoder is synchronous, so the processing time against the target frame duration is its load.
 */
export function calculateEncoderUtilization(
  isHardwareEncoder: boolean,
  backlogSize: number,
  processingTimeMs: number,
  targetFrameDurationMs: number,
): number {
  let utilization: number;
  if (isHardwareEncoder) {
    const backlog = backlogSize / MAX_BACKLOG_SIZE;
    const latency = processingTimeMs / (targetFrameDurationMs * PIPELINE_SIZE);
    utilization = Math.max(backlog, latency);
  } else {
    utilization = processingTimeMs / targetFrameDurationMs;
  }
  return Math.min(Math.max(utilization, 0), MAX_ENCODER_UTILIZATION);
}

/** The exponential moving average `ComputeAndRecordUtilization` keeps over the raw utilization. */
export class EncoderUtilizationAverage {
  private ema: number | undefined;

  record(raw: number): number {
    this.ema = this.ema === undefined ? raw : raw * UTILIZATION_EMA_WEIGHT + this.ema * (1 - UTILIZATION_EMA_WEIGHT);
    return this.ema;
  }
}

/**
 * `ComputeLossiness`: how heavily a frame was compressed, as its share of the target bitrate times its normalized
 * quantizer (or, with no quantizer, the estimated complexity of the frame's pixels). Rate controllers use it to
 * decide whether to drop the frame rate so each frame gets a larger bit budget.
 */
export function computeLossiness(dataBytes: number, frameDurationMs: number, targetBitrate: number, complexity: number): number {
  const duration = frameDurationMs / 1000;
  if (duration <= 0) return 0;
  if (!(targetBitrate > 0)) throw new RangeError("target bitrate must be positive");
  // 1. the effective bitrate of this frame, 2. its share of the target, 3. scaled by the quantizer or complexity.
  const actualBitrate = (dataBytes * 8) / duration;
  const rawLossiness = (actualBitrate / targetBitrate) * complexity;
  // 4. an upper bound protects the rate controller from timestamp jitter.
  return Math.min(Math.max(rawLossiness, 0), MAX_LOSSINESS);
}
