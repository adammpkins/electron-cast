/**
 * A map ordered by key, for the places where openscreen uses `std::map` and erases `begin()` (the smallest key) to
 * bound its size: `StatisticsAnalyzer` (`recent_frame_infos_`, `recent_packet_infos_`) and `ClockOffsetEstimatorImpl`
 * (`events_`). Keys arrive almost in order, so insertion is at or near the end of a sorted array.
 */
export class SortedMap<K, V> {
  private readonly keys: K[] = [];
  private readonly values = new Map<unknown, V>();
  private readonly compare: (a: K, b: K) => number;
  private readonly id: (key: K) => unknown;

  /** `id` maps a key to a primitive that is equal exactly when the keys are (for composite keys). */
  constructor(compare: (a: K, b: K) => number, id: (key: K) => unknown = (k) => k) {
    this.compare = compare;
    this.id = id;
  }

  get size(): number {
    return this.keys.length;
  }

  get(key: K): V | undefined {
    return this.values.get(this.id(key));
  }

  has(key: K): boolean {
    return this.values.has(this.id(key));
  }

  /** The smallest key (`begin()->first`). */
  firstKey(): K | undefined {
    return this.keys[0];
  }

  set(key: K, value: V): void {
    const id = this.id(key);
    if (!this.values.has(id)) this.keys.splice(this.lowerBound(key), 0, key);
    this.values.set(id, value);
  }

  delete(key: K): boolean {
    const id = this.id(key);
    if (!this.values.has(id)) return false;
    this.values.delete(id);
    this.keys.splice(this.lowerBound(key), 1);
    return true;
  }

  /** `erase(begin())`. */
  deleteFirst(): void {
    const first = this.keys.shift();
    if (first !== undefined) this.values.delete(this.id(first));
  }

  private lowerBound(key: K): number {
    const n = this.keys.length;
    // Appending in order is by far the common case.
    if (n === 0 || this.compare(this.keys[n - 1]!, key) < 0) return n;
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.compare(this.keys[mid]!, key) < 0) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
}
