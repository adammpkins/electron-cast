/**
 * Truncated-integer expansion, ported from openscreen `cast/streaming/impl/expanded_value_base.h`
 * (`ExpandLessThanOrEqual`, `ExpandGreaterThan`) as used by `FrameId` (`public/frame_id.h`). Frame ids are plain
 * numbers here; the first frame is 0 and `FrameId::leader()` is -1. They stay far below 2^53.
 */

/** The greatest value <= `value` whose lower `bits` bits are `x` (`ExpandLessThanOrEqual`). */
export function expandLessThanOrEqual(value: number, x: number, bits: 8 | 16 | 32): number {
  const span = 2 ** bits;
  // Floor-based modulo so negative values (the leader, -1) expand as the C++ two's-complement masks do.
  const base = value - (((value % span) + span) % span);
  let result = base + x;
  if (result > value) result -= span;
  return result;
}

/** The smallest value > `value` whose lower `bits` bits are `x` (`ExpandGreaterThan`). */
export function expandGreaterThan(value: number, x: number, bits: 8 | 16 | 32): number {
  return expandLessThanOrEqual(value + 2 ** bits, x, bits);
}
