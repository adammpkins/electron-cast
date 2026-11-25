/**
 * Network bandwidth estimator, ported from openscreen `cast/streaming/impl/bandwidth_estimator.cc`
 * (`BandwidthEstimator`, `FlowTracker`).
 *
 * Two 256-slot rings of `timesliceDuration` each track what the router sent (`burstHistory`) and what the receiver
 * acknowledged (`feedbackHistory`, placed in time at ack arrival minus the round trip). Over the part of the window
 * that both cover, the estimate is acknowledged bytes divided by the time it would have taken to send what was sent
 * at the router's maximum rate.
 */

/** bandwidth_estimator.h `kNumTimeslices`. */
export const NUM_TIMESLICES = 256;

const INT32_MAX = 2147483647;
const INT32_MIN = -2147483648;

function saturateInt32(v: number): number {
  return Math.max(INT32_MIN, Math.min(INT32_MAX, v));
}

/** `FlowTracker`. Times are milliseconds (fractional allowed); the ring index math is mod 256 as in the C++. */
class FlowTracker {
  private readonly timesliceMs: number;
  private beginMs: number;
  private readonly ring = new Int32Array(NUM_TIMESLICES);
  private tail = 0;

  constructor(timesliceMs: number, beginMs: number) {
    this.timesliceMs = timesliceMs;
    this.beginMs = beginMs;
  }

  get beginTime(): number {
    return this.beginMs;
  }

  get endTime(): number {
    return this.beginMs + this.timesliceMs * NUM_TIMESLICES;
  }

  /** `AdvanceToIncludeTime`: drop too-old slices and add zeroed ones so the newest slice includes `until`. */
  advanceToIncludeTime(until: number): void {
    if (until < this.endTime) return;
    const numPeriods = 1 + Math.floor((until - this.endTime) / this.timesliceMs);
    this.beginMs += numPeriods * this.timesliceMs;
    const shift = Math.min(numPeriods, NUM_TIMESLICES);
    for (let i = 0; i < shift; i++) {
      this.ring[this.tail] = 0;
      this.tail = (this.tail + 1) & 0xff;
    }
  }

  /** `Accumulate`: add `amount` to the slice that includes `when`. */
  accumulate(amount: number, when: number): void {
    if (when < this.beginMs) return;
    this.advanceToIncludeTime(when);
    const offset = Math.floor((when - this.beginMs) / this.timesliceMs);
    const index = (this.tail + offset) & 0xff;
    this.ring[index] = saturateInt32(this.ring[index]! + amount);
  }

  sum(): number {
    let result = 0;
    for (const v of this.ring) result += v;
    return saturateInt32(result);
  }
}

export class BandwidthEstimator {
  private readonly maxBytesPerHistoryWindow: number;
  private readonly historyWindowMs: number;
  private readonly burstHistory: FlowTracker;
  private readonly feedbackHistory: FlowTracker;

  constructor(maxBytesPerTimeslice: number, timesliceDurationMs: number, startTimeMs: number) {
    if (!(maxBytesPerTimeslice > 0 && timesliceDurationMs > 0)) throw new RangeError("invalid estimator parameters");
    this.maxBytesPerHistoryWindow = maxBytesPerTimeslice * NUM_TIMESLICES;
    this.historyWindowMs = timesliceDurationMs * NUM_TIMESLICES;
    this.burstHistory = new FlowTracker(timesliceDurationMs, startTimeMs);
    this.feedbackHistory = new FlowTracker(timesliceDurationMs, startTimeMs);
  }

  /** `OnBurstComplete`. */
  onBurstComplete(numBytesSent: number, whenMs: number): void {
    this.burstHistory.accumulate(numBytesSent, whenMs);
  }

  /** `OnRtcpReceived`. */
  onRtcpReceived(arrivalTimeMs: number, estimatedRoundTripTimeMs: number): void {
    this.feedbackHistory.advanceToIncludeTime(arrivalTimeMs - estimatedRoundTripTimeMs);
  }

  /** `OnPayloadReceived`. */
  onPayloadReceived(payloadBytesAcknowledged: number, ackArrivalTimeMs: number, estimatedRoundTripTimeMs: number): void {
    this.feedbackHistory.accumulate(payloadBytesAcknowledged, ackArrivalTimeMs - estimatedRoundTripTimeMs);
  }

  /** `ComputeNetworkBandwidth`: bits per second, 0 when there is not enough history. */
  computeNetworkBandwidth(): number {
    const overlapBegin = Math.max(this.burstHistory.beginTime, this.feedbackHistory.beginTime);
    const overlapEnd = Math.min(this.burstHistory.endTime, this.feedbackHistory.endTime);
    if (overlapEnd - overlapBegin < this.historyWindowMs / 2) return 0;
    const transmitted = this.burstHistory.sum();
    if (transmitted <= 0) return 0;
    const transmitDurationMs = (this.historyWindowMs * transmitted) / this.maxBytesPerHistoryWindow;
    if (transmitDurationMs <= 0) return 0;
    const received = this.feedbackHistory.sum();
    // ToClampedBitsPerSecond, saturated to int.
    return Math.min(INT32_MAX, Math.trunc((received * 8 * 1000) / transmitDurationMs));
  }
}
