/**
 * Frame types, from openscreen `cast/streaming/public/encoded_frame.h` (`EncodedFrame`) and
 * `impl/frame_crypto.h` (`EncryptedFrame`). Times are milliseconds on a monotonic clock as `number`; the RTP
 * timestamp is the 64-bit `RtpTimeTicks` as `number` (it stays far below 2^53).
 */
export type Dependency = "dependent" | "independent" | "key";

export interface EncodedFrame {
  dependency: Dependency;
  frameId: number;
  /** Equals `frameId` for key frames (encoded_frame.h `referenced_frame_id`). */
  referencedFrameId: number;
  rtpTimestamp: number;
  /** Capture time on the sender clock. */
  referenceTimeMs: number;
  /** encoded_frame.h `new_playout_delay`: non-positive means no change. */
  newPlayoutDelayMs: number;
  data: Uint8Array;
  /** When capture of the frame began and ended, on the sender clock; absent when the source does not say. */
  captureBeginTimeMs?: number;
  captureEndTimeMs?: number;
}

/** `EncryptedFrame` has the same metadata and the ciphertext as `data`. */
export type EncryptedFrame = EncodedFrame;
