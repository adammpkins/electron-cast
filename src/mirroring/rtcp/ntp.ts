/**
 * NTP time conversion, ported from openscreen `cast/streaming/impl/ntp_time.cc` (`NtpTimeConverter::ToNtpTimestamp`,
 * `ToLocalTime`) and `StatusReportId` from `impl/rtcp_common.h` / `sender_report_builder.cc`
 * (`GetRecentReportTime`).
 *
 * Local times are milliseconds on a monotonic clock (`number`, sub-millisecond precision kept); NTP timestamps are
 * 64-bit (`bigint`): seconds since 1900 in the high 32 bits, a 2^-32 fraction in the low 32.
 */

/** ntp_time.cc `kTimeBetweenNtpEpochAndUnixEpoch`. */
export const NTP_TO_UNIX_EPOCH_SECONDS = 2208988800n;
const ERA_SECONDS = 1n << 32n;
const FRACTION_UNITS = 1n << 32n;

export class NtpTimeConverter {
  readonly startTimeMs: number;
  private readonly sinceNtpEpochSeconds: bigint;

  /**
   * @param startTimeMs the local time the converter is anchored at (the session start).
   * @param sinceUnixEpochSeconds wall-clock seconds since the Unix epoch at that moment.
   */
  constructor(startTimeMs: number, sinceUnixEpochSeconds: number) {
    this.startTimeMs = startTimeMs;
    this.sinceNtpEpochSeconds = BigInt(Math.trunc(sinceUnixEpochSeconds)) + NTP_TO_UNIX_EPOCH_SECONDS;
  }

  /** `ToNtpTimestamp`. */
  toNtpTimestamp(timeMs: number): bigint {
    const us = BigInt(Math.round((timeMs - this.startTimeMs) * 1000));
    const whole = us / 1_000_000n;
    const remainderUs = us - whole * 1_000_000n;
    const fraction = (remainderUs * FRACTION_UNITS) / 1_000_000n;
    const seconds = this.sinceNtpEpochSeconds + whole;
    return ((seconds & 0xffffffffn) << 32n) | (fraction & 0xffffffffn);
  }

  /** `ToLocalTime`, including the year-2036 era adjustment. */
  toLocalTime(timestamp: bigint): number {
    let ntpSeconds = timestamp >> 32n;
    // A timestamp that looks earlier than 1970 is assumed to be past the 2036 wrap-around.
    if (ntpSeconds <= NTP_TO_UNIX_EPOCH_SECONDS) ntpSeconds += ERA_SECONDS;
    const whole = ntpSeconds - this.sinceNtpEpochSeconds;
    const fractionUs = ((timestamp & 0xffffffffn) * 1_000_000n) / FRACTION_UNITS;
    return this.startTimeMs + Number(whole) * 1000 + Number(fractionUs) / 1000;
  }

  /** `SenderReportBuilder::GetRecentReportTime`: the latest report time not after `onOrBeforeMs` for a status id. */
  getRecentReportTime(reportId: number, onOrBeforeMs: number): number {
    const max = this.toNtpTimestamp(onOrBeforeMs);
    let reconstructed = (max & (0xffffn << 48n)) | (BigInt(reportId >>> 0) << 16n);
    // Rollover of the lower 48 bits: subtract one from the upper 16.
    if (reconstructed > max) reconstructed -= 1n << 48n;
    return this.toLocalTime(reconstructed);
  }
}

/** `ToStatusReportId`: the middle 32 bits of a 64-bit NTP timestamp. */
export function toStatusReportId(ntp: bigint): number {
  return Number((ntp >> 16n) & 0xffffffffn);
}
