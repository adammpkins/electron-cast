/**
 * Audio frame policy, ported from Chromium `media/cast/sender/audio_sender.cc` (`AudioSender`): `InsertAudio` asks
 * the frame sender whether to drop before encoding, and `OnEncodedAudioFrame` enqueues the encoded frame.
 * The encoder (WebCodecs `AudioEncoder`) is outside this class; it reports `samplesPerFrame` and gets raw audio.
 */
import { FrameSender, type FrameSenderClient, type SenderEncodedFrame } from "./frame-sender.ts";

export class AudioSender implements FrameSenderClient {
  private readonly frameSender: FrameSender;
  private readonly rtpTimebase: number;
  private readonly samplesPerFrame: number;
  private samplesInEncoder = 0;
  framesInserted = 0;
  framesDropped = 0;

  constructor(frameSender: FrameSender, rtpTimebase: number, samplesPerFrame: number) {
    this.frameSender = frameSender;
    this.rtpTimebase = rtpTimebase;
    this.samplesPerFrame = samplesPerFrame;
    // audio_sender.cc constructor: max frame rate = rtp_timebase / samples per frame.
    frameSender.setMaxFrameRate(rtpTimebase / samplesPerFrame);
  }

  getNumberOfFramesInEncoder(): number {
    // A partial frame may be in the encoder; the floor is enough for the design-limit check.
    return Math.floor(this.samplesInEncoder / this.samplesPerFrame);
  }

  getEncoderBacklogDuration(): number {
    return (this.samplesInEncoder * 1000) / this.rtpTimebase;
  }

  /** `InsertAudio`: true when the audio should be encoded. The audio encoder assigns RTP timestamps itself. */
  insertAudio(frames: number): boolean {
    this.framesInserted++;
    const nextFrameDuration = (frames * 1000) / this.rtpTimebase;
    const reason = this.frameSender.shouldDropNextFrame(nextFrameDuration, undefined);
    if (reason !== "kNotDropped") {
      this.framesDropped++;
      return false;
    }
    this.samplesInEncoder += frames;
    return true;
  }

  /** `OnEncodedAudioFrame`. */
  onEncodedAudioFrame(encoded: SenderEncodedFrame, samplesSkipped: number): void {
    const samplesProcessed = this.samplesPerFrame + samplesSkipped;
    this.samplesInEncoder = Math.max(0, this.samplesInEncoder - samplesProcessed);
    if (this.frameSender.enqueueFrame(encoded) !== "kNotDropped") this.framesDropped++;
  }
}
