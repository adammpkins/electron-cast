// Chrome's `MediaSinkServiceStatus` (chrome/browser/media/router/mojo/media_sink_service_status.cc): the debugging record of
// in-browser discovery that `chrome://media-router-internals` shows as its state. `MediaRouterDesktop` fills it from two
// places: the sinks each discovery service reports (`MediaRouterDesktop::OnUserGesture` subscribes
// `UpdateDiscoveredSinks` to `DualMediaSinkService::AddSinksDiscoveredCallback`) and the sinks each provider reports for a
// media source (`MediaRouterDesktop::OnSinksReceived` -> `UpdateAvailableSinks`). Pure module: no Electron imports.
import type { MediaSink } from "./manager-api.ts";

/** `kMaxAvailableSinksSize`: the available-sink lists of this many sources are kept, the least recently updated going first. */
const MAX_AVAILABLE_SINKS_SIZE = 100;
/** `log_util::TruncateId` (components/media_router/browser/log_util.cc): ids are cut to 9 characters. */
const ID_MAX_LENGTH = 9;
/** `kDiscoveryTimeout` (`MediaSinkServiceBase`): a change to a discovery service's sinks is reported 3 s after the first of a run. */
const DISCOVERY_TIMEOUT_MS = 3000;
/** `mojom::MediaRouteProviderId` as `ProviderIdToString` (media_route_provider_helper.cc) writes it; only the ones this library has. */
export type StatusProviderId = "CAST" | "DIAL";

/** `static_cast<int>(SinkIconType)` (components/media_router/common/media_sink.h). */
const ICON_TYPE: Record<MediaSink["iconType"], number> = { cast: 0, cast_audio_group: 1, cast_audio: 2, generic: 7 };

/**
 * `ToValue(const MediaSinkInternal&)`: one discovered sink, with Chrome's field names. A DIAL sink has `ip_address`,
 * `model_name` and `app_url`; a Cast sink has `ip_endpoint`, `model_name`, `capabilities`, `channel_id` and
 * `discovered_by_dial`.
 */
export interface DiscoveredSinkStatus {
  id: string;
  name: string;
  icon_type: number;
  ip_address?: string;
  model_name?: string;
  app_url?: string;
  ip_endpoint?: string;
  capabilities?: number;
  /**
   * `CastSinkExtraData::cast_channel_id`, the number of the Cast socket. This library does not number its channels, so it
   * is 0 (what Chrome's field holds before a socket exists).
   */
  channel_id?: number;
  discovered_by_dial?: boolean;
}

/** `MediaSinkServiceStatus::GetStatusAsValue`: what `chrome://media-router-internals` reads with its `getState` message. */
export interface MediaSinkServiceStatusValue {
  /** Keyed by provider name: `cast` and `dial` (`DualMediaSinkService::Initialize`). */
  discovered_sinks: Record<string, DiscoveredSinkStatus[]>;
  /** Keyed by `<PROVIDER>:<media source>` (`UpdateAvailableSinks`); the sinks are their ids, cut to 9 characters. */
  available_sinks: Record<string, string[]>;
}

function truncateId(id: string): string {
  return id.length <= ID_MAX_LENGTH ? id : id.slice(0, ID_MAX_LENGTH);
}

/** `net::IPEndPoint::ToString`. */
function endpointToString(address: string, port: number): string {
  return address.includes(":") ? `[${address}]:${port}` : `${address}:${port}`;
}

/**
 * `ToValue(const MediaSinkInternal&)`. `discoveredByDial` is `CastSinkExtraData::discovery_type == CastDiscoveryType::kDial`.
 * The keys are in the order a `base::DictValue` (a sorted map) writes them.
 */
export function sinkToStatusValue(sink: MediaSink, discoveredByDial: boolean): DiscoveredSinkStatus {
  const device = sink.device;
  if (device.dial !== undefined) {
    return {
      app_url: device.dial.appUrl,
      icon_type: ICON_TYPE[sink.iconType],
      id: truncateId(sink.id),
      ip_address: device.dial.ipAddress,
      model_name: device.dial.modelName,
      name: sink.name,
    };
  }
  return {
    capabilities: device.capabilities,
    channel_id: 0,
    discovered_by_dial: discoveredByDial,
    icon_type: ICON_TYPE[sink.iconType],
    id: truncateId(sink.id),
    ip_endpoint: endpointToString(device.addresses[0] ?? device.host, device.port),
    model_name: device.model,
    name: sink.name,
  };
}

/** What a discovery service reports: the sink and whether a DIAL discovery found it. */
export interface DiscoveredSink {
  sink: MediaSink;
  discoveredByDial: boolean;
}

/** `MediaSinkServiceStatus`. */
export class MediaSinkServiceStatus {
  private readonly discovered = new Map<string, DiscoveredSinkStatus[]>();
  /** An LRU in insertion order: the first key is the least recently updated (`base::LRUCache`). */
  private readonly available = new Map<string, string[]>();

  /** `UpdateDiscoveredSinks`: a discovery service reports the sinks it has now. */
  updateDiscoveredSinks(providerName: string, sinks: readonly DiscoveredSink[]): void {
    this.discovered.set(providerName, sinks.map((s) => sinkToStatusValue(s.sink, s.discoveredByDial)));
  }

  /** `UpdateAvailableSinks`: a provider reports the sinks available for a media source. Only the ids are kept, as only they are shown. */
  updateAvailableSinks(providerId: StatusProviderId, mediaSource: string, sinkIds: readonly string[]): void {
    // Chrome keys the cache with this serialized string too (`base::StrCat({ProviderIdToString, ":", media_source})`)
    const key = `${providerId}:${mediaSource}`;
    this.available.delete(key);
    this.available.set(key, sinkIds.map(truncateId));
    if (this.available.size > MAX_AVAILABLE_SINKS_SIZE) {
      const oldest = this.available.keys().next();
      if (oldest.done !== true) this.available.delete(oldest.value);
    }
  }

  /** `GetStatusAsValue`. A `base::DictValue` is sorted by key, so the keys here are too. */
  getStatusAsValue(): MediaSinkServiceStatusValue {
    const discovered: Record<string, DiscoveredSinkStatus[]> = {};
    for (const key of [...this.discovered.keys()].sort()) discovered[key] = (this.discovered.get(key) ?? []).map((s) => ({ ...s }));
    const available: Record<string, string[]> = {};
    for (const key of [...this.available.keys()].sort()) available[key] = [...(this.available.get(key) ?? [])];
    return { available_sinks: available, discovered_sinks: discovered };
  }

  /** `GetStatusAsJSONString`: pretty printed, as `ToJSONString` does. */
  getStatusAsJSONString(): string {
    return JSON.stringify(this.getStatusAsValue(), null, 3);
  }
}

/**
 * `MediaSinkServiceBase` seen from the status: when the sinks of a discovery service change, they are reported 3 s later
 * (`StartTimer`, `OnDiscoveryComplete`), and only when the list differs from the last one reported. A service that never
 * had a sink reports nothing, so it has no entry.
 */
export class DiscoveredSinksTracker {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private previous = "[]";
  private readonly status: MediaSinkServiceStatus;
  private readonly providerName: string;
  private readonly sinks: () => DiscoveredSink[];
  private readonly timeoutMs: number;
  private readonly unsubscribe: () => void;

  constructor(
    status: MediaSinkServiceStatus,
    providerName: string,
    sinks: () => DiscoveredSink[],
    /** Calls the listener each time a sink is added, changed or removed; returns the function that stops it. */
    subscribe: (listener: () => void) => () => void,
    timeoutMs: number = DISCOVERY_TIMEOUT_MS,
  ) {
    this.status = status;
    this.providerName = providerName;
    this.sinks = sinks;
    this.timeoutMs = timeoutMs;
    this.unsubscribe = subscribe(() => this.startTimer());
  }

  /** `MediaSinkServiceBase::StartTimer`: does nothing while a run is open. */
  private startTimer(): void {
    if (this.timer !== undefined) return;
    this.timer = setTimeout(() => this.onDiscoveryComplete(), this.timeoutMs);
    this.timer.unref?.();
  }

  /** `MediaSinkServiceBase::OnDiscoveryComplete`. */
  private onDiscoveryComplete(): void {
    this.timer = undefined;
    // `MediaSinkServiceBase::sinks_` is a `flat_map` keyed by sink id
    const sinks = this.sinks().sort((a, b) => (a.sink.id < b.sink.id ? -1 : a.sink.id > b.sink.id ? 1 : 0));
    const key = JSON.stringify(sinks.map((s) => sinkToStatusValue(s.sink, s.discoveredByDial)));
    if (key === this.previous) return;
    this.previous = key;
    this.status.updateDiscoveredSinks(this.providerName, sinks);
  }

  dispose(): void {
    this.unsubscribe();
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
