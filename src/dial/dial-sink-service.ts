// DIAL sinks: the registry's devices turned into sinks through their device descriptions, and per-app availability
// through app info. After DeviceDescriptionService, DialAppDiscoveryService and DialMediaSinkServiceImpl
// (chrome/browser/media/router/discovery/dial/).
import { EventEmitter } from "node:events";
import type { DialHttp } from "./http.ts";
import {
  getDialAppUrl, isValidDeviceUrl, parseAppInfo, parseDeviceDescription, processDeviceUuid,
  type DialAppInfoResult, type DialDeviceData, type ParsedDialDeviceDescription,
} from "./parse.ts";

/** A DIAL device as a sink (`MediaSink` with `DialSinkExtraData`). */
export interface DialSink {
  /** `dial:<uuid>`: the UDN without `uuid:` and dashes, in lower case. */
  id: string;
  /** The friendly name from the device description. */
  name: string;
  /** `DialSinkExtraData::model_name`. */
  modelName: string;
  /** `DialSinkExtraData::ip_address`. */
  ipAddress: string;
  /** `DialSinkExtraData::app_url`: the device's Application-URL without a trailing slash. */
  appUrl: string;
}

/** The registry as the sink service sees it. */
export interface DialDeviceSource {
  on(event: "deviceList", listener: (devices: DialDeviceData[]) => void): unknown;
  off(event: "deviceList", listener: (devices: DialDeviceData[]) => void): unknown;
  discoverNow(): boolean;
}

export interface DialSinkServiceOptions {
  source: DialDeviceSource;
  http: DialHttp;
  /** Epoch milliseconds; default `Date.now`. */
  now?: () => number;
  /** `kDiscoveryTimeout` 3 s: sinks are published this long after the last change (`MediaSinkServiceBase::StartTimer`). */
  settleMs?: number;
  /** `kDeviceDescriptionCacheTimeHours` 12 h. */
  descriptionCacheMs?: number;
  /**
   * True when a Cast sink has this id (the part after `dial:`, `cast:<uuid>` there). Chromium removes such a sink from the DIAL service
   * (`CastMediaSinkServiceImpl::TryConnectDialDiscoveredSink`, `OnChannelOpenSucceeded`), so here it is hidden: it is
   * not listed, queried for apps, or routable. Call {@link DialSinkService.refilter} when the answer may have changed.
   */
  isCastSink?: (uuid: string) => boolean;
}

export interface DialSinkServiceEvents {
  /** The sink list changed, or an app became (un)available on a sink that is listed. */
  change: [];
}

type SinkAppStatus = "available" | "unavailable";

/** `kDiscoveryOnlyModelNames` (dial_media_sink_service_impl.cc): found by SSDP but not DIAL servers. */
const DISCOVERY_ONLY_MODELS = new Set(["eureka dongle", "chromecast audio", "chromecast ultra"]);
const CACHE_MAX_ENTRIES = 256;

function sameSink(a: DialSink, b: DialSink): boolean {
  return a.id === b.id && a.name === b.name && a.modelName === b.modelName && a.ipAddress === b.ipAddress && a.appUrl === b.appUrl;
}

/** `GetSinkAppStatusFromResponse`: a parse or HTTP failure means the app is not there; a network failure says nothing. */
function statusOf(result: DialAppInfoResult): SinkAppStatus | null {
  if (result.appInfo === null) {
    return result.resultCode === "parsing_error" || result.resultCode === "http_error" ? "unavailable" : null;
  }
  return result.appInfo.state === "running" || result.appInfo.state === "stopped" ? "available" : "unavailable";
}

export class DialSinkService extends EventEmitter<DialSinkServiceEvents> {
  private readonly source: DialDeviceSource;
  private readonly http: DialHttp;
  private readonly now: () => number;
  private readonly settleMs: number;
  private readonly cacheMs: number;
  private readonly isCastSink: (uuid: string) => boolean;
  private readonly all = new Map<string, DialSink>();
  private latest = new Map<string, DialSink>();
  private currentLabels = new Set<string>();
  private readonly statuses = new Map<string, SinkAppStatus>();
  private readonly queries = new Map<string, number>();
  private readonly cache = new Map<string, { expires: number; configId: number | null; description: ParsedDialDeviceDescription; ipAddress: string }>();
  private readonly fetching = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private previousPublished = "";
  private stopped = false;
  private readonly onList = (devices: DialDeviceData[]): void => this.onDeviceList(devices);

  constructor(options: DialSinkServiceOptions) {
    super();
    this.source = options.source;
    this.http = options.http;
    this.now = options.now ?? Date.now;
    this.settleMs = options.settleMs ?? 3000;
    this.cacheMs = options.descriptionCacheMs ?? 12 * 60 * 60 * 1000;
    this.isCastSink = options.isCastSink ?? (() => false);
    this.source.on("deviceList", this.onList);
  }

  /** `GetSinks`, minus the sinks that are Cast sinks too. */
  sinks(): DialSink[] {
    return [...this.all.values()].filter((s) => !this.hidden(s)).map((s) => ({ ...s }));
  }

  /** `GetSinkById`. */
  getSink(id: string): DialSink | undefined {
    const sink = this.all.get(id);
    return sink === undefined || this.hidden(sink) ? undefined : { ...sink };
  }

  /** `GetAvailableSinks(app_name)`: the sinks whose app info for `appName` said the app exists. */
  availableSinks(appName: string): DialSink[] {
    return this.sinks().filter((s) => this.statuses.get(`${s.id}:${appName}`) === "available");
  }

  /**
   * `StartMonitoringAvailableSinksForApp`: starts finding out which sinks have `appName`, until the returned function
   * is called. Several monitors of one app share the work.
   */
  monitorApp(appName: string): () => void {
    const count = this.queries.get(appName) ?? 0;
    this.queries.set(appName, count + 1);
    if (count === 0) for (const sink of this.sinks()) this.fetchAppInfoForSink(sink, appName);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.queries.get(appName) ?? 1) - 1;
      if (left <= 0) this.queries.delete(appName);
      else this.queries.set(appName, left);
    };
  }

  /** `DialAppDiscoveryService::FetchDialAppInfo`: always asks the device for the app's current state. */
  async fetchAppInfo(sink: DialSink, appName: string): Promise<DialAppInfoResult> {
    const url = getDialAppUrl(sink.appUrl, appName);
    if (url === null) return { appInfo: null, resultCode: "network_error", errorMessage: "Invalid app URL" };
    const res = await this.http.get(url, true);
    if (!res.ok) {
      // `OnDialAppInfoFetchError`: a 2xx answer that failed (an empty body) is a parse problem, any other status an HTTP one.
      const code = res.status === undefined ? "network_error" : res.status >= 200 && res.status < 300 ? "parsing_error" : "http_error";
      return {
        appInfo: null,
        resultCode: code,
        errorMessage: res.message,
        ...(res.status !== undefined ? { httpErrorCode: res.status } : {}),
      };
    }
    const info = parseAppInfo(res.body);
    return info === null
      ? { appInfo: null, resultCode: "parsing_error", errorMessage: "" }
      : { appInfo: info, resultCode: "ok", errorMessage: "" };
  }

  /** `DiscoverSinksNow`: another SSDP cycle, and another look at apps whose state was never learnt. */
  discoverNow(): void {
    this.source.discoverNow();
    for (const sink of this.sinks()) for (const app of this.queries.keys()) this.fetchAppInfoForSink(sink, app);
  }

  /** Tell the service the Cast sinks changed, so the sinks that are also Cast sinks are hidden or shown again. */
  refilter(): void {
    if (this.stopped) return;
    for (const sink of this.sinks()) for (const app of this.queries.keys()) this.fetchAppInfoForSink(sink, app);
    this.publishIfChanged();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.source.off("deviceList", this.onList);
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.all.clear();
    this.latest.clear();
    this.queries.clear();
  }

  private hidden(sink: DialSink): boolean {
    return this.isCastSink(sink.id.slice("dial:".length));
  }

  /** `OnDialDeviceList`: forget the previous round's sinks and look every device up again. */
  private onDeviceList(devices: DialDeviceData[]): void {
    if (this.stopped) return;
    this.currentLabels = new Set(devices.map((d) => d.label));
    this.latest = new Map();
    this.getDescriptions(devices);
    this.startTimer();
  }

  /** `DeviceDescriptionService::GetDeviceDescriptions`. */
  private getDescriptions(devices: DialDeviceData[]): void {
    for (const [label, entry] of this.cache) if (this.now() >= entry.expires) this.cache.delete(label);
    for (const device of devices) {
      const cached = this.cache.get(device.label);
      if (cached !== undefined) {
        // `CheckAndUpdateCache`: a changed config id, an expired entry, or an address that no longer fits drops it.
        const valid = cached.configId === device.configId && this.now() < cached.expires
          && isValidDeviceUrl(cached.description.appUrl, device.ipAddress);
        if (valid) {
          this.onDescription(device, cached.description);
          continue;
        }
        this.cache.delete(device.label);
      }
      void this.fetchDescription(device);
    }
  }

  /** `DeviceDescriptionFetcher`: GET the description (no Origin header) and read the Application-URL header. */
  private async fetchDescription(device: DialDeviceData): Promise<void> {
    if (this.fetching.has(device.label)) return;
    this.fetching.add(device.label);
    try {
      const res = await this.http.get(device.descriptionUrl, false);
      if (this.stopped || !this.currentLabels.has(device.label)) return;
      if (!res.ok) return;
      const header = (res.headers["application-url"] ?? "").trim();
      if (header === "") return;
      if (!isValidDeviceUrl(header, device.ipAddress)) return;
      // The DIAL spec implies the Application-URL has no trailing slash; Chromium strips one.
      const appUrl = new URL(header).pathname.endsWith("/") ? header.slice(0, -1) : header;
      const parsed = parseDeviceDescription(res.body, appUrl, device.ipAddress);
      if (!parsed.ok) return;
      if (this.cache.size < CACHE_MAX_ENTRIES) {
        this.cache.set(device.label, {
          expires: this.now() + this.cacheMs,
          configId: device.configId,
          description: parsed.value,
          ipAddress: device.ipAddress,
        });
      }
      this.onDescription(device, parsed.value);
    } finally {
      this.fetching.delete(device.label);
    }
  }

  /** `OnDeviceDescriptionAvailable`. */
  private onDescription(device: DialDeviceData, description: ParsedDialDeviceDescription): void {
    if (this.stopped || !this.currentLabels.has(device.label)) return;
    const id = `dial:${processDeviceUuid(description.uniqueId)}`;
    const sink: DialSink = {
      id,
      name: description.friendlyName,
      modelName: description.modelName,
      ipAddress: device.ipAddress,
      appUrl: description.appUrl,
    };
    this.latest.set(id, sink);
    this.startTimer();
    for (const app of this.queries.keys()) this.fetchAppInfoForSink(sink, app);
  }

  /** `MediaSinkServiceBase::StartTimer`: runs once; further changes inside the window share it. */
  private startTimer(): void {
    if (this.timer !== null || this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.onDiscoveryComplete();
    }, this.settleMs);
    this.timer.unref?.();
  }

  /** `DialMediaSinkServiceImpl::OnDiscoveryComplete`: the sinks that answered replace the sinks that were known. */
  private onDiscoveryComplete(): void {
    if (this.stopped) return;
    for (const id of this.all.keys()) if (!this.latest.has(id)) this.all.delete(id);
    for (const [id, sink] of this.latest) {
      const old = this.all.get(id);
      if (old === undefined || !sameSink(old, sink)) this.all.set(id, sink);
    }
    this.publishIfChanged();
  }

  private publishIfChanged(): void {
    const key = JSON.stringify(this.sinks());
    if (key === this.previousPublished) return;
    this.previousPublished = key;
    this.emit("change");
  }

  /** `FetchAppInfoForSink`: asks only about what is not known yet, and never a discovery-only model. */
  private fetchAppInfoForSink(sink: DialSink, appName: string): void {
    if (DISCOVERY_ONLY_MODELS.has(sink.modelName.toLowerCase())) return;
    if (this.hidden(sink)) return;
    const key = `${sink.id}:${appName}`;
    if (this.statuses.has(key)) return;
    void this.fetchAppInfo(sink, appName).then((result) => {
      if (this.stopped) return;
      const status = statusOf(result);
      if (status === null) return;
      const old = this.statuses.get(key);
      this.statuses.set(key, status);
      if (old === status) return;
      // The sink may be gone by now: the status is kept for later, but nobody is told.
      if (this.all.has(sink.id) && this.queries.has(appName)) this.emit("change");
    });
  }
}
