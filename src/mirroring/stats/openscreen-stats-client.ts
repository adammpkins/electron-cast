/**
 * Keeps the most recent statistics as Chrome's dictionary, ported from Chromium
 * `components/mirroring/service/openscreen_stats_client.cc` (`OpenscreenStatsClient`).
 */
import { senderStatsToDict, type MirroringStats, type SenderStats, type SenderStatsClient } from "./statistics.ts";

export class OpenscreenStatsClient implements SenderStatsClient {
  private mostRecentStats: MirroringStats = {};

  /** `GetStats`: a copy, empty until the first analysis. */
  getStats(): MirroringStats {
    return structuredClone(this.mostRecentStats);
  }

  /** `OnStatisticsUpdated`. */
  onStatisticsUpdated(stats: SenderStats): void {
    this.mostRecentStats = senderStatsToDict(stats);
  }
}
