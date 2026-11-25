/**
 * Estimates the offset between the sender's and the receiver's clocks, ported from openscreen
 * `cast/streaming/impl/clock_offset_estimator.h` and `clock_offset_estimator_impl.{h,cc}`.
 *
 * Two bounds are tracked, each a Kalman-filtered one-way delay: a packet is sent by the sender and logged as received
 * by the receiver (`latency + offset`), and a frame ack is sent by the receiver and received by the sender
 * (`latency - offset`). Half their sum is the offset, half their difference the latency.
 */
import { SortedMap } from "./sorted-map.ts";
import type { FrameEvent, PacketEvent } from "./statistics-common.ts";

/** `kMaxEventTimesMapSize`. */
const MAX_EVENT_TIMES_MAP_SIZE = 500;
/** `kProcessNoise` (Q, 5 ms) and `kMeasurementNoise` (R, 30 ms); the filter works in milliseconds squared. */
const PROCESS_NOISE_MS = 5;
const MEASUREMENT_NOISE_MS = 30;

/** `ClockOffsetEstimator`. */
export interface ClockOffsetEstimator {
  onFrameEvent(event: FrameEvent): void;
  onPacketEvent(event: PacketEvent): void;
  /** Receiver clock minus sender clock, or undefined before both bounds have a measurement. */
  getEstimatedOffset(): number | undefined;
  getEstimatedLatency(): number | undefined;
}

/** `ClockOffsetEstimatorImpl::KalmanFilter`: a one-dimensional filter over a slowly changing latency. */
class KalmanFilter {
  private readonly q = PROCESS_NOISE_MS * PROCESS_NOISE_MS;
  private readonly r = MEASUREMENT_NOISE_MS * MEASUREMENT_NOISE_MS;
  private estimate = 0;
  private errorCovariance = 0;
  private hasEstimate = false;

  get has(): boolean {
    return this.hasEstimate;
  }

  get value(): number {
    return this.estimate;
  }

  update(measurement: number): void {
    if (!this.hasEstimate) {
      this.estimate = measurement;
      this.errorCovariance = this.r;
      this.hasEstimate = true;
      return;
    }
    const predicted = this.errorCovariance + this.q;
    const gain = predicted / (predicted + this.r);
    this.estimate += gain * (measurement - this.estimate);
    this.errorCovariance = (1 - gain) * predicted;
  }
}

/** `ClockOffsetEstimatorImpl::BoundCalculator`: pairs the sent and received time of an event, feeds the difference to the filter. */
class BoundCalculator {
  private readonly filter = new KalmanFilter();
  private readonly events = new SortedMap<bigint, { sent?: number; received?: number }>((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  get hasBound(): boolean {
    return this.filter.has;
  }

  get bound(): number {
    return this.filter.value;
  }

  setSent(rtp: number, packetId: number, audio: boolean, t: number): void {
    const key = makeEventKey(rtp, packetId, audio);
    this.entry(key).sent = t;
    this.checkUpdate(key);
  }

  setReceived(rtp: number, packetId: number, audio: boolean, t: number): void {
    const key = makeEventKey(rtp, packetId, audio);
    this.entry(key).received = t;
    this.checkUpdate(key);
  }

  private entry(key: bigint): { sent?: number; received?: number } {
    let e = this.events.get(key);
    if (e === undefined) {
      e = {};
      this.events.set(key, e);
    }
    return e;
  }

  private checkUpdate(key: bigint): void {
    const e = this.events.get(key)!;
    if (e.sent !== undefined && e.received !== undefined) {
      this.filter.update(e.received - e.sent);
      this.events.delete(key);
      return;
    }
    // Drop the entry with the smallest key (the oldest in practice) once the map is too large.
    if (this.events.size > MAX_EVENT_TIMES_MAP_SIZE) this.events.deleteFirst();
  }
}

/** `MakeEventKey`: packet id, then the low 32 bits of the RTP timestamp, then the media type. */
function makeEventKey(rtp: number, packetId: number, audio: boolean): bigint {
  const low32 = BigInt.asUintN(32, BigInt(Math.trunc(rtp)));
  return (BigInt(packetId) << 48n) | (low32 << 1n) | (audio ? 1n : 0n);
}

/** `ClockOffsetEstimator::Create`. */
export function createClockOffsetEstimator(): ClockOffsetEstimator {
  const frameBound = new BoundCalculator();
  const packetBound = new BoundCalculator();

  const bounds = (): { frame: number; packet: number } | undefined => {
    if (!frameBound.hasBound || !packetBound.hasBound) return undefined;
    return { frame: -frameBound.bound, packet: packetBound.bound };
  };

  return {
    onFrameEvent(e) {
      const audio = e.mediaType === "audio";
      if (e.type === "frameAckSent") frameBound.setSent(e.rtpTimestamp, 0, audio, e.timestamp);
      else if (e.type === "frameAckReceived") frameBound.setReceived(e.rtpTimestamp, 0, audio, e.timestamp);
    },
    onPacketEvent(e) {
      const audio = e.mediaType === "audio";
      if (e.type === "packetSentToNetwork") packetBound.setSent(e.rtpTimestamp, e.packetId, audio, e.timestamp);
      else if (e.type === "packetReceived") packetBound.setReceived(e.rtpTimestamp, e.packetId, audio, e.timestamp);
    },
    getEstimatedOffset() {
      const b = bounds();
      return b === undefined ? undefined : (b.packet + b.frame) / 2;
    },
    getEstimatedLatency() {
      const b = bounds();
      return b === undefined ? undefined : (b.packet - b.frame) / 2;
    },
  };
}
