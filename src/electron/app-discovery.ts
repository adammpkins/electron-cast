// Which sinks can run which receiver app, asked over the sinks' kept-open channels (GET_APP_AVAILABILITY), as Chrome's
// CastAppDiscoveryServiceImpl does with a CastAppAvailabilityTracker
// (chrome/browser/media/router/providers/cast/cast_app_discovery_service.cc, cast_app_availability_tracker.cc). Apps
// are asked about only while somebody observes a source that names them, on every sink, when the observation starts and
// whenever a sink's channel opens; the answers are kept per sink and app and refreshed by Chrome's rules. Nothing here
// opens a connection: a sink with no open channel right now is skipped, as Chrome skips a sink whose socket is gone.
import type { CastDevice } from "../discovery/index.ts";
import type { CastClientLike } from "./session-service.ts";

/** `kRefreshThreshold`: how long an "unavailable" answer stands before the app is asked about again. */
export const APP_AVAILABILITY_REFRESH_MS = 60_000;

/** `cast_channel::GetAppAvailabilityResult`. */
export type AppAvailabilityResult = "available" | "unavailable" | "unknown";

/** The part of a `CastMediaSource` availability depends on: its apps (any one will do) and the capabilities it needs. */
export interface CastAppSource {
  appIds: string[];
  /** Capability names every sink must have (`required_capabilities`). */
  capabilities: string[];
}

/** What the discovery needs of the sink service. */
export interface AppDiscoverySinks {
  /** The current sinks (`GetSinks`), reported or not. */
  sinks(): CastDevice[];
  sinkOf(deviceId: string): CastDevice | undefined;
  /** The sink's open channel, if it has one now (`GetSocket`). */
  clientOf(deviceId: string): CastClientLike | undefined;
}

const CAPABILITY_BITS: Record<string, number> = { video_out: 1, video_in: 2, audio_out: 4, audio_in: 8, multizone_group: 32 };

/** `capabilities.HasAll(required_capabilities)` in `GetAvailableSinks`; unknown names are ignored, as in the session service. */
function hasAll(device: CastDevice, capabilities: string[]): boolean {
  for (const cap of capabilities) {
    const bit = CAPABILITY_BITS[cap];
    if (bit !== undefined && (device.capabilities & bit) === 0) return false;
  }
  return true;
}

const sourceKey = (s: CastAppSource): string => JSON.stringify([[...s.appIds].sort(), [...s.capabilities].sort()]);

interface Query {
  source: CastAppSource;
  callbacks: Set<{ fn: (sinks: CastDevice[]) => void }>;
}

export class CastAppDiscovery {
  private readonly sinkService: AppDiscoverySinks;
  private readonly now: () => number;
  /** `capabilities_and_availabilities_`: sink id -> app id -> the answer and when it came. */
  private readonly results = new Map<string, Map<string, { result: AppAvailabilityResult; at: number }>>();
  /** `registration_count_by_app_id_`. */
  private readonly appCounts = new Map<string, number>();
  /** `sink_queries_`, keyed by source. */
  private readonly queries = new Map<string, Query>();
  /** Bumped when a sink's channel opens or the sink goes, so an answer that was in flight across it is dropped. */
  private readonly generation = new Map<string, number>();
  private readonly pending = new Map<string, { appId: string; done: Promise<void> }>();
  private disposed = false;

  constructor(sinkService: AppDiscoverySinks, now: () => number = Date.now) {
    this.sinkService = sinkService;
    this.now = now;
  }

  /** `CastAppAvailabilityTracker::GetAvailability`: kUnknown (at 0) for a sink or app never answered. */
  availability(sinkId: string, appId: string): { result: AppAvailabilityResult; at: number } {
    return this.results.get(sinkId)?.get(appId) ?? { result: "unknown", at: 0 };
  }

  /**
   * The answer that stands, or undefined when the app has to be asked about again (`ShouldRefreshAppAvailability`):
   * kAvailable stands, kUnavailable for `APP_AVAILABILITY_REFRESH_MS`, kUnknown never.
   */
  cached(sinkId: string, appId: string): boolean | undefined {
    const { result, at } = this.availability(sinkId, appId);
    if (result === "available") return true;
    if (result === "unavailable" && this.now() - at <= APP_AVAILABILITY_REFRESH_MS) return false;
    return undefined;
  }

  /** `GetAvailableSinks` then `GetSinksByIds`: the current sinks that have one of the source's apps and its capabilities. */
  availableSinks(source: CastAppSource): CastDevice[] {
    return this.sinkService.sinks().filter((d) =>
      hasAll(d, source.capabilities) && source.appIds.some((app) => this.availability(d.id, app).result === "available"));
  }

  /**
   * `StartObservingMediaSinks`: the callback gets the source's sinks at once if there are any, and again whenever an app
   * of the source becomes available or stops being so on a sink, or a sink that has one comes or goes. The first
   * observer of a source has its newly registered apps asked about on every sink. Returns the unsubscribe function;
   * the last one unregisters the source (`MaybeRemoveSinkQueryEntry`), keeping the answers.
   */
  startObserving(source: CastAppSource, callback: (sinks: CastDevice[]) => void): () => void {
    const cached = this.availableSinks(source);
    if (cached.length > 0) this.call(callback, cached);
    const key = sourceKey(source);
    let query = this.queries.get(key);
    if (query === undefined) {
      query = { source: { appIds: [...source.appIds], capabilities: [...source.capabilities] }, callbacks: new Set() };
      this.queries.set(key, query);
      for (const appId of this.register(query.source)) {
        for (const sink of this.sinkService.sinks()) void this.request(sink.id, appId);
      }
    }
    const entry = { fn: callback };
    query.callbacks.add(entry);
    const q = query;
    return () => {
      if (!q.callbacks.delete(entry) || q.callbacks.size > 0 || this.queries.get(key) !== q) return;
      this.queries.delete(key);
      this.unregister(q.source);
    };
  }

  /** Resolves once no request about the source's apps is in flight (for a first answer that has to be waited for). */
  async settled(source: CastAppSource): Promise<void> {
    for (;;) {
      const waiting = [...this.pending.values()].filter((p) => source.appIds.includes(p.appId)).map((p) => p.done);
      if (waiting.length === 0) return;
      await Promise.all(waiting);
    }
  }

  /** `Refresh` (Chrome: `DiscoverSinksNow`): every registered app, on every sink, by the refresh rules. */
  refresh(): void {
    for (const sink of this.sinkService.sinks()) for (const appId of this.appCounts.keys()) void this.request(sink.id, appId);
  }

  /**
   * `RequestAppAvailability`: ask the sink about the app unless the answer stands. An error or no answer is kUnknown.
   * Resolves when the answer is in (at once when nothing is asked).
   */
  request(sinkId: string, appId: string): Promise<void> {
    if (this.disposed || this.cached(sinkId, appId) !== undefined) return Promise.resolve();
    const generation = this.generation.get(sinkId) ?? 0;
    const key = `${sinkId}\n${generation}\n${appId}`;
    const inFlight = this.pending.get(key);
    if (inFlight !== undefined) return inFlight.done;
    // Chrome: no socket for the sink's channel id, so nothing is asked (it is logged)
    const client = this.sinkService.clientOf(sinkId);
    if (client === undefined) return Promise.resolve();
    const done = (async (): Promise<void> => {
      let result: AppAvailabilityResult;
      try {
        const ask = client.getAppAvailability;
        // a client that cannot ask (a custom CastClientLike) is taken to have every app
        result = ask === undefined || (await ask.call(client, [appId]))[appId] === true ? "available" : "unavailable";
      } catch {
        result = "unknown";
      } finally {
        this.pending.delete(key);
      }
      // the channel was replaced or the sink went while it was asked: the answer is about the old one
      if (this.disposed || (this.generation.get(sinkId) ?? 0) !== generation) return;
      this.update(sinkId, appId, result);
    })();
    this.pending.set(key, { appId, done });
    return done;
  }

  /**
   * `OnSinkAddedOrUpdated` (the sink's channel opened): the queries that list the sink are told again, and every
   * registered app is asked about on it.
   */
  onSinkAddedOrUpdated(device: CastDevice): void {
    this.generation.set(device.id, (this.generation.get(device.id) ?? 0) + 1);
    this.notify(this.supportedQueries(device.id));
    for (const appId of this.appCounts.keys()) void this.request(device.id, appId);
  }

  /** `OnSinkRemoved` -> `RemoveResultsForSink`: its answers go, and the queries that listed it are told. */
  onSinkRemoved(device: CastDevice): void {
    const affected = this.supportedQueries(device.id);
    this.results.delete(device.id);
    this.generation.set(device.id, (this.generation.get(device.id) ?? 0) + 1);
    this.notify(affected);
  }

  dispose(): void {
    this.disposed = true;
    this.queries.clear();
    this.appCounts.clear();
    this.results.clear();
  }

  /** `UpdateAppAvailability`: the queries of the app are told only when it becomes, or stops being, available. */
  private update(sinkId: string, appId: string, result: AppAvailabilityResult): void {
    let apps = this.results.get(sinkId);
    if (apps === undefined) this.results.set(sinkId, (apps = new Map()));
    const old = apps.get(appId)?.result ?? "unknown";
    apps.set(appId, { result, at: this.now() });
    if (old === result || (old !== "available" && result !== "available")) return;
    this.notify([...this.queries.values()].filter((q) => q.source.appIds.includes(appId)));
  }

  /** `GetSupportedSources`: the queries with an app the sink has. */
  private supportedQueries(sinkId: string): Query[] {
    const apps = this.results.get(sinkId);
    if (apps === undefined) return [];
    const available = [...apps].filter(([, a]) => a.result === "available").map(([id]) => id);
    return [...this.queries.values()].filter((q) => q.source.appIds.some((id) => available.includes(id)));
  }

  /** `UpdateSinkQueries`. */
  private notify(queries: Query[]): void {
    for (const q of queries) {
      if (this.queries.get(sourceKey(q.source)) !== q) continue;
      const sinks = this.availableSinks(q.source);
      for (const entry of [...q.callbacks]) this.call(entry.fn, sinks);
    }
  }

  private call(fn: (sinks: CastDevice[]) => void, sinks: CastDevice[]): void {
    try {
      fn(sinks.map((d) => ({ ...d })));
    } catch (err) {
      console.error("electron-cast: an app availability observer failed", err);
    }
  }

  /** `RegisterSource`: the apps no other registered source names yet. */
  private register(source: CastAppSource): string[] {
    const fresh: string[] = [];
    for (const appId of new Set(source.appIds)) {
      const n = (this.appCounts.get(appId) ?? 0) + 1;
      this.appCounts.set(appId, n);
      if (n === 1) fresh.push(appId);
    }
    return fresh;
  }

  /** `UnregisterSource`. */
  private unregister(source: CastAppSource): void {
    for (const appId of new Set(source.appIds)) {
      const n = (this.appCounts.get(appId) ?? 1) - 1;
      if (n > 0) this.appCounts.set(appId, n);
      else this.appCounts.delete(appId);
    }
  }
}
