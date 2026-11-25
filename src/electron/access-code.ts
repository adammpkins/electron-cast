// Adds a device the app already knows the address of, as Chrome's Access Code Cast adds the device its discovery server
// resolved from a code (chrome/browser/media/router/discovery/access_code/, docs/DESIGN.md lists each rule with its
// Chromium source). Everything before the address is known is Google's: Chrome sends the typed code, with the profile's
// OAuth token for the `cast-edu-messaging` scope, to castedumessaging-pa.googleapis.com. That step is not here (docs/DESIGN.md,
// "Access code casting"); the app resolves the address however it can, then calls `addSinkByAddress`.
// Nothing here is specific to an app.
import net from "node:net";
import type { CastDevice } from "../discovery/index.ts";
import type { CastSinkService, OpenBackoff } from "./sink-service.ts";

/** The device a discovery server returned, as `DiscoveryDevice` (discovery_resources.proto) carries it, flattened. */
export interface AccessCodeDevice {
  /** The device's unique id (`DiscoveryDevice.id`); `uuid:` and dashes are dropped and case folded, as for an mDNS id. */
  id: string;
  /** `display_name`. */
  name: string;
  /** `device_capabilities`; a capability left out is false. */
  capabilities: AccessCodeCapabilities;
  /** `network_info.ip_v6_address`. Used in preference to the IPv4 address, as `GetIPAddress` does. An IP literal, no zone id. */
  ipV6Address?: string;
  /** `network_info.ip_v4_address`. */
  ipV4Address?: string;
  /** `network_info.port`: a number, or a decimal string as the server sends it. Left out or empty, 8009. */
  port?: number | string;
  /** `network_info.host_name`. Carried by the server's reply; Chrome never uses it. */
  hostName?: string;
}

/** `DeviceCapabilities` (discovery_resources.proto). */
export interface AccessCodeCapabilities {
  videoOut?: boolean;
  videoIn?: boolean;
  audioOut?: boolean;
  audioIn?: boolean;
  devMode?: boolean;
}

/** Why a device could not be made into a sink: `CreateCastMediaSinkResult` (the values `CreateAccessCodeMediaSink` returns). */
export type SinkCreationFailure = "missing_or_invalid_ip_address" | "missing_id" | "missing_friendly_name" | "missing_or_invalid_port";

/**
 * How adding a device ended (Chrome: `AddSinkResultCode`, the values that can arise without the discovery server).
 * `response_malformed` is the server's reply being unusable; here, the object passed in.
 */
export type AddSinkResult =
  | { code: "ok"; sinkId: string }
  | { code: "response_malformed"; message: string }
  | { code: "sink_creation_error"; reason: SinkCreationFailure; message: string }
  | { code: "channel_open_error"; message: string };

/** What is kept of a device added by access code (Chrome: an entry of `kAccessCodeCastDevices` and its addition time). */
export interface AccessCodeRememberedSink {
  id: string;
  name: string;
  /** Canonical IP literal. */
  ip: string;
  port: number;
  /** `CastDeviceCapabilitySet::ToEnumBitmask()`, the same bits as an mDNS `ca` record. */
  capabilities: number;
  model: string;
  /** Milliseconds since the epoch when the device was added (`kAccessCodeCastDeviceAdditionTime`); absent means expired. */
  addedAt?: number;
}

/**
 * Where remembered devices are kept between runs (Chrome: the profile's prefs). The app owns the storage. `load` is
 * called once, when the service starts, and may return anything: entries that do not validate are dropped, as Chrome
 * drops them (`ValidateStoredDevices`). `save` gets the whole list after each change.
 */
export interface AccessCodeStore {
  load(): unknown[] | Promise<unknown[]>;
  save(sinks: AccessCodeRememberedSink[]): void | Promise<void>;
}

export interface AccessCodeOptions {
  /** Chrome's `AccessCodeCastEnabled` policy. Default false: nothing can be added and nothing is remembered. */
  enabled?: boolean;
  /**
   * Chrome's `AccessCodeCastDeviceDuration` policy: how many seconds an added device stays listed, counted from when it
   * was added. Default 0, as in Chrome: it is listed for 20 s (so that a route can be created) and, once a route to it
   * ends, removed.
   */
  deviceDuration?: number;
  /** Default: kept in memory, so remembered devices last until the manager is disposed. */
  store?: AccessCodeStore;
  /** Chrome writes these to `chrome://media-router-internals`. */
  log?(level: "info" | "warning" | "error", message: string, sinkId: string): void;
  /** For tests: the clock the addition times and expiry use, in ms. Default `Date.now`. */
  now?(): number;
}

/** A route as the expiry logic needs it. */
export interface AccessCodeRoute {
  id: string;
  sinkId: string;
  /** Chrome's `is_local`: a session this app holds. */
  isLocal: boolean;
}

/** Where the routes come from (Chrome: `MediaRouter::GetCurrentRoutes` and a `MediaRoutesObserver`). */
export interface AccessCodeRoutes {
  current(): AccessCodeRoute[];
  /** Call the listener whenever the routes may have changed; returns the unsubscribe function. */
  observe(listener: () => void): () => void;
}

/** What the service needs of the sink service. */
export type AccessCodeSinkHost = Pick<
  CastSinkService,
  "hasSink" | "sinkOf" | "openSink" | "updateSinkDetails" | "disconnectAndRemoveSink" | "on" | "off"
>;

/** Thrown by `addSinkByAddress` when access-code casting is not enabled (Chrome: `GetForProfile` returns no service). */
export class AccessCodeCastDisabledError extends Error {
  constructor() {
    super("access code casting is not enabled: pass accessCode: { enabled: true } or call configureAccessCode");
    this.name = "AccessCodeCastDisabledError";
  }
}

/** Chrome's `kDefaultAccessCodeModelName`: code that keys on a model name treats anything "Chromecast..." as first party. */
const MODEL_NAME = "Chromecast Cast Moderator";
/** `kCastControlPort`. */
const CAST_CONTROL_PORT = 8009;
/** `AccessCodeCastSinkService::kExpirationTimerDelay`. */
const EXPIRATION_TIMER_DELAY_MS = 20_000;
/** `AccessCodeCastSinkService::kExpirationDelay`. */
const EXPIRATION_DELAY_MS = 450;
/** `AccessCodeCastSinkService::kNetworkChangeBuffer`. */
const NETWORK_CHANGE_BUFFER_MS = 4000;

// `CreateCastSocketOpenParams` (access_code_cast_sink_service.cc): connect 2 s, ping every 4 s, dead after 8 s.
const MANUAL_ENTRY_PARAMS = { connectTimeoutMs: 2000, livenessTimeoutMs: 8000, pingIntervalMs: 4000 };
// `backoff_policy_` (same file): 1 s between attempts, 50% jitter, no growth. The attempts are the service's three.
const MANUAL_ENTRY_BACKOFF: OpenBackoff = { initialDelayMs: 1000, multiplyFactor: 1, jitter: 0.5, maxDelayMs: 1000 };

const CAPABILITY_BITS: ReadonlyArray<[keyof AccessCodeCapabilities, number]> = [
  // `cast_channel::CastDeviceCapability` order; the bits are those of an mDNS `ca` record
  ["videoOut", 1], ["videoIn", 2], ["audioOut", 4], ["audioIn", 8], ["devMode", 16],
];

/** `net::IPAddress::AssignFromIPLiteral`: an IPv4 or IPv6 literal with no brackets or zone. Returns its canonical text. */
function ipLiteral(value: unknown): string | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  if (net.isIPv4(value)) return value;
  if (!net.isIPv6(value) || value.includes("%")) return undefined;
  try {
    return new URL(`http://[${value}]`).hostname.slice(1, -1);
  } catch {
    return undefined;
  }
}

/** `MediaSinkInternal::ProcessDeviceUUID`. */
function processDeviceUuid(id: string): string {
  const bare = id.startsWith("uuid:") ? id.slice(5) : id;
  return bare.replaceAll("-", "").toLowerCase();
}

/** `base::StringToInt` then `net::IsPortValid`; an absent port is `kCastControlPort`. */
function portOf(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return CAST_CONTROL_PORT;
  let n: number;
  if (typeof value === "number") n = value;
  else if (typeof value === "string" && /^[+-]?\d+$/.test(value)) n = Number(value);
  else return undefined;
  if (!Number.isInteger(n) || n < -(2 ** 31) || n > 2 ** 31 - 1) return undefined;
  // net::IsPortValid is 0..65535, so port 0 passes here (and then fails to connect)
  return n >= 0 && n <= 65535 ? n : undefined;
}

export type CreatedAccessCodeSink = { ok: true; device: CastDevice } | { ok: false; result: Exclude<AddSinkResult, { code: "ok" }> };

const malformed = (message: string): CreatedAccessCodeSink => ({ ok: false, result: { code: "response_malformed", message } });
const failed = (reason: SinkCreationFailure, message: string): CreatedAccessCodeSink => ({
  ok: false,
  result: { code: "sink_creation_error", reason, message },
});

/**
 * Make a sink of what a discovery server returned: the checks of `ConstructDiscoveryDeviceFromJson`
 * (access_code_cast_discovery_interface.cc) on the shape, then `CreateAccessCodeMediaSink` (access_code_media_sink_util.cc)
 * in its order. Nothing is opened; the result is the device the sink service would list.
 */
export function createAccessCodeSink(input: unknown): CreatedAccessCodeSink {
  const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  // ConstructDiscoveryDeviceFromJson: the device is an object with a string display name and a string id
  if (!isObject(input)) return malformed("the device is not an object");
  if (typeof input["name"] !== "string") return malformed("the device has no name");
  if (typeof input["id"] !== "string") return malformed("the device has no id");
  // (same) capabilities is an object; a capability that is there must be a bool, one that is not counts as false
  const capabilities = input["capabilities"];
  if (!isObject(capabilities)) return malformed("the device has no capabilities");
  let bits = 0;
  for (const [key, bit] of CAPABILITY_BITS) {
    const value = capabilities[key];
    if (value === undefined) continue;
    if (typeof value !== "boolean") return malformed(`capability ${key} is not a boolean`);
    if (value) bits |= bit;
  }

  // `GetIPAddress`: IPv6 first, then IPv4; a value that is not a string counts as absent (`FindString`)
  const ip = ipLiteral(input["ipV6Address"]) ?? ipLiteral(input["ipV4Address"]);
  if (ip === undefined) return failed("missing_or_invalid_ip_address", "neither ipV6Address nor ipV4Address is an IP address literal");
  if (input["id"] === "") return failed("missing_id", "the device id is empty");
  if (input["name"] === "") return failed("missing_friendly_name", "the device name is empty");
  const port = portOf(input["port"]);
  if (port === undefined) return failed("missing_or_invalid_port", `"${String(input["port"])}" is not a port`);

  const id = processDeviceUuid(input["id"]);
  return {
    ok: true,
    device: {
      id,
      name: input["name"],
      model: MODEL_NAME,
      host: ip,
      addresses: [ip],
      port,
      capabilities: bits,
      isGroup: false,
      statusText: "",
      instanceName: "",
      txt: {},
    },
  };
}

/** `ParseValueDictIntoMediaSinkInternal`: a stored entry is usable or dropped. */
function parseRemembered(value: unknown): AccessCodeRememberedSink | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  const ip = ipLiteral(v["ip"]);
  if (ip === undefined) return undefined;
  if (typeof v["port"] !== "number" || !Number.isInteger(v["port"])) return undefined;
  if (typeof v["capabilities"] !== "number" || !Number.isInteger(v["capabilities"])) return undefined;
  if (typeof v["id"] !== "string" || typeof v["name"] !== "string") return undefined;
  return {
    id: v["id"],
    name: v["name"],
    ip,
    port: v["port"],
    capabilities: v["capabilities"],
    model: typeof v["model"] === "string" ? v["model"] : MODEL_NAME,
    ...(typeof v["addedAt"] === "number" && Number.isFinite(v["addedAt"]) ? { addedAt: v["addedAt"] } : {}),
  };
}

const deviceOf = (r: AccessCodeRememberedSink): CastDevice => ({
  id: r.id,
  name: r.name,
  model: r.model,
  host: r.ip,
  addresses: [r.ip],
  port: r.port,
  capabilities: r.capabilities,
  isGroup: (r.capabilities & 32) !== 0,
  statusText: "",
  instanceName: "",
  txt: {},
});

/** How a sink got here (Chrome: `CastDiscoveryType::kAccessCodeManualEntry` and `kAccessCodeRememberedDevice`). */
type Kind = "manual" | "remembered";

interface ExpirySlot {
  /** Undefined once the timer has fired (Chrome keeps the entry; `IsRunning()` is false). */
  timer: ReturnType<typeof setTimeout> | undefined;
}

/**
 * `AccessCodeCastSinkService` without the discovery server: adds a device by address, remembers it for the configured
 * duration, and removes it when that has passed, or sooner when a route to it ends.
 */
export class AccessCodeSinks {
  private readonly host: AccessCodeSinkHost;
  private readonly routes: AccessCodeRoutes;
  private readonly store: AccessCodeStore;
  private readonly logFn: NonNullable<AccessCodeOptions["log"]>;
  private readonly now: () => number;
  private enabled: boolean;
  private durationSeconds: number;
  /** `kAccessCodeCastDevices` with `kAccessCodeCastDeviceAdditionTime`, validated. */
  private readonly entries = new Map<string, AccessCodeRememberedSink>();
  /** The sinks this service put in the sink service, and how (a sink's `discovery_type`). */
  private readonly kinds = new Map<string, Kind>();
  /** `current_session_expiration_timers_`. */
  private readonly expiry = new Map<string, ExpirySlot>();
  private readonly delayed = new Set<ReturnType<typeof setTimeout>>();
  private previousRoutes = new Map<string, string>();
  private readonly unobserve: () => void;
  private readonly onSinkRemoved = (device: CastDevice): void => void this.kinds.delete(device.id);
  /** The remembered devices read from the store (Chrome reads its prefs when the service is made, so only once enabled). */
  private loaded: Promise<void> | undefined;
  /** Set while the start-up read and re-adding is under way. */
  private starting: Promise<void> | undefined;
  private disposed = false;

  constructor(host: AccessCodeSinkHost, routes: AccessCodeRoutes, options: AccessCodeOptions = {}) {
    this.host = host;
    this.routes = routes;
    this.enabled = options.enabled ?? false;
    this.durationSeconds = checkedDuration(options.deviceDuration ?? 0);
    this.store = options.store ?? memoryStore();
    this.logFn = options.log ?? (() => {});
    this.now = options.now ?? Date.now;
    this.previousRoutes = new Map(routes.current().map((r) => [r.id, r.sinkId]));
    this.unobserve = routes.observe(() => this.onRoutesUpdated());
    this.host.on("sinkRemoved", this.onSinkRemoved);
    // The service exists only while enabled (`AccessCodeCastSinkServiceFactory::BuildServiceInstanceForBrowserContext`), and
    // its constructor runs InitializePrefUpdater() then InitAllStoredDevices()
    if (this.enabled) this.start();
  }

  private start(): Promise<void> {
    const starting = this.loadOnce().then(() => {
      if (this.starting === starting) this.starting = undefined;
      if (this.enabled && !this.disposed) this.initAllStoredDevices();
    });
    this.starting = starting;
    return starting;
  }

  private loadOnce(): Promise<void> {
    return (this.loaded ??= this.load());
  }

  /** The remembered devices being read and re-added, when that is still under way. */
  ready(): Promise<void> | undefined {
    return this.starting;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** The devices remembered now (`kAccessCodeCastDevices`), oldest first. */
  remembered(): AccessCodeRememberedSink[] {
    return [...this.entries.values()].map((e) => ({ ...e }));
  }

  /**
   * Chrome's policies are `dynamic_refresh`: a change takes effect while it runs. Turning access code casting off removes
   * the devices from the list, stops their timers and forgets them (`OnEnabledPrefChange`); changing the duration restarts
   * every timer from each device's addition time (`OnDurationPrefChange`).
   */
  async configure(settings: { enabled?: boolean; deviceDuration?: number }): Promise<void> {
    await this.starting;
    if (this.disposed) return;
    if (settings.deviceDuration !== undefined) {
      const seconds = checkedDuration(settings.deviceDuration);
      if (seconds !== this.durationSeconds) {
        this.durationSeconds = seconds;
        if (this.enabled) this.onDurationChanged();
      }
    }
    if (settings.enabled !== undefined && settings.enabled !== this.enabled) {
      this.enabled = settings.enabled;
      if (this.enabled) await this.start();
      else this.onDisabled();
    }
  }

  /**
   * `AccessCodeCastSinkService::OnAccessCodeValidated` and what follows it: check the device, open a channel to it, list it
   * and remember it. Rejects with {@link AccessCodeCastDisabledError} unless enabled.
   */
  async addSinkByAddress(input: AccessCodeDevice): Promise<AddSinkResult> {
    if (!this.enabled) throw new AccessCodeCastDisabledError();
    await this.starting;
    if (this.disposed) return { code: "channel_open_error", message: "the cast manager was disposed" };
    const created = createAccessCodeSink(input);
    if (!created.ok) {
      this.log("error", created.result.message, "");
      return created.result;
    }
    return this.addSinkToMediaRouter(created.device, "manual");
  }

  /**
   * The network the machine is on changed (Chrome: `DiscoveryNetworkMonitor` -> `OnNetworksChanged`; electron-cast cannot
   * tell, so the app says). Devices without a route leave the list now, and the remembered ones are tried again after
   * 4.45 s, so those on the new network come back.
   */
  networksChanged(): void {
    if (!this.enabled || this.disposed) return;
    this.removeAndDisconnectExistingSinksOnNetwork();
    this.later(EXPIRATION_DELAY_MS + NETWORK_CHANGE_BUFFER_MS, () => {
      this.resetExpirationTimers();
      this.initAllStoredDevices();
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unobserve();
    this.host.off("sinkRemoved", this.onSinkRemoved);
    this.resetExpirationTimers();
    for (const t of this.delayed) clearTimeout(t);
    this.delayed.clear();
  }

  // ----- adding

  /** `AddSinkToMediaRouter` and `OpenChannelIfNecessary`. */
  private async addSinkToMediaRouter(device: CastDevice, kind: Kind): Promise<AddSinkResult> {
    if (this.host.hasSink(device.id)) {
      this.log("info", "The sink already exists in the media router, no channel needs to be opened.", device.id);
      // Only refresh data if this new sink came from typing in an access code. The store gets the new data, the existing
      // sink only its name and capabilities (it keeps the endpoint it has a channel to).
      if (kind === "manual") {
        this.storeSinkInPrefs(device);
        this.setExpirationTimer(device.id);
        this.updateExistingSink(device);
      }
      return { code: "ok", sinkId: device.id };
    }
    this.log("info", "Attempting to open a cast channel.", device.id);
    // For the manual entry case Chrome uses its own open params and back-off, so that failure happens much faster. For
    // remembered devices it uses the sink service's defaults.
    const opened = await this.host.openSink(device, kind === "manual" ? { params: MANUAL_ENTRY_PARAMS, backoff: MANUAL_ENTRY_BACKOFF } : {});
    if (!opened) {
      this.log("error", "The channel failed to open.", device.id);
      return { code: "channel_open_error", message: `no channel could be opened to ${device.host}:${device.port}` };
    }
    this.log("info", "The channel successfully opened.", device.id);
    this.kinds.set(device.id, kind);
    if (kind === "manual") this.storeSinkAndSetExpirationTimer(device.id);
    return { code: "ok", sinkId: device.id };
  }

  /** `UpdateExistingSink`. */
  private updateExistingSink(fresh: CastDevice): void {
    const existing = this.host.sinkOf(fresh.id);
    if (existing === undefined) return;
    if (existing.name === fresh.name && existing.capabilities === fresh.capabilities) return;
    this.host.updateSinkDetails(fresh.id, { name: fresh.name, capabilities: fresh.capabilities });
  }

  // ----- storing and expiring

  /** `StoreSinkAndSetExpirationTimer`: the timer reads the addition time, so it is set after the store. */
  private storeSinkAndSetExpirationTimer(sinkId: string): void {
    const sink = this.host.sinkOf(sinkId);
    if (sink === undefined) {
      this.log("error", "Unable to remember the cast sink since it was not present in the media router.", "");
      return;
    }
    this.storeSinkInPrefs(sink);
    this.setExpirationTimer(sinkId);
  }

  /**
   * `StoreSinkInPrefs`: the addition time is now, and the sink replaces any entry with the same IP endpoint, so one device
   * is not listed twice under an older name (`UpdateDevicesDict`, `GetMatchingIPEndPoints`). Chrome leaves the old id's
   * expiry timer running and so does this; it finds nothing to remove when it fires.
   */
  private storeSinkInPrefs(sink: CastDevice): void {
    for (const [id, entry] of this.entries) {
      if (entry.ip === sink.host && entry.port === sink.port) this.entries.delete(id);
    }
    this.entries.set(sink.id, {
      id: sink.id,
      name: sink.name,
      ip: sink.host,
      port: sink.port,
      capabilities: sink.capabilities,
      model: sink.model,
      addedAt: this.now(),
    });
    this.persist();
  }

  /** `RemoveSinkIdFromAllEntries`. */
  private removeSinkIdFromAllEntries(sinkId: string): void {
    if (this.entries.delete(sinkId)) this.persist();
  }

  /** `CalculateDurationTillExpiration`: ms until the duration since the addition time has passed, 0 if it has or is unknown. */
  private durationTillExpiration(sinkId: string): number {
    const addedAt = this.entries.get(sinkId)?.addedAt;
    if (addedAt === undefined) {
      this.log("warning", `We couldn't fetch the stored duration for some reason, default to instantly expiring this sink: ${sinkId}`, "");
      return 0;
    }
    const duration = this.enabled ? this.durationSeconds : 0; // GetAccessCodeDeviceDurationPref
    return Math.max(addedAt + duration * 1000 - this.now(), 0);
  }

  /** `SetExpirationTimer` and `DoSetExpirationTimer`: 20 s more than the time left, so the route can be created first. */
  private setExpirationTimer(sinkId: string): void {
    const remaining = this.durationTillExpiration(sinkId);
    const existing = this.expiry.get(sinkId);
    if (existing?.timer !== undefined) clearTimeout(existing.timer);
    const slot: ExpirySlot = { timer: undefined };
    slot.timer = setTimeout(() => {
      slot.timer = undefined;
      this.onExpiration(sinkId);
    }, remaining + EXPIRATION_TIMER_DELAY_MS);
    slot.timer.unref?.();
    this.expiry.set(sinkId, slot);
  }

  private resetExpirationTimers(): void {
    for (const slot of this.expiry.values()) if (slot.timer !== undefined) clearTimeout(slot.timer);
    this.expiry.clear();
  }

  /** `OnExpiration`: a device a page is casting to stays until its route ends. */
  private onExpiration(sinkId: string): void {
    this.log("info", `The sink id: ${sinkId} has expired. Checking to see if there is an active route, otherwise remove it from the media router and erase all stored references.`, sinkId);
    if (this.activeRoute(sinkId)?.isLocal === true) {
      this.log("info", `The sink id: ${sinkId} still has a local route open. Wait to expire it until the route has ended.`, sinkId);
      return;
    }
    this.expireSink(sinkId);
  }

  /** `ExpireSink`. */
  private expireSink(sinkId: string): void {
    this.removeSinkIdFromAllEntries(sinkId);
    this.removeAndDisconnectMediaSinkFromRouter(sinkId);
  }

  /** `RemoveAndDisconnectMediaSinkFromRouter`: never a sink a page is casting to; the removal comes 450 ms later. */
  private removeAndDisconnectMediaSinkFromRouter(sinkId: string): void {
    if (this.host.sinkOf(sinkId) === undefined) return;
    if (this.activeRoute(sinkId)?.isLocal === true) return;
    this.log("info", "Attempting to disconnect and remove the cast sink from the media router.", sinkId);
    this.later(EXPIRATION_DELAY_MS, () => this.host.disconnectAndRemoveSink(sinkId));
  }

  /** `CheckMediaSinkForExpiration` and `DoCheckMediaSinkForExpiration`: expire a device whose time is up without waiting for its timer. */
  private checkMediaSinkForExpiration(sinkId: string): void {
    if (this.durationTillExpiration(sinkId) !== 0) return;
    const slot = this.expiry.get(sinkId);
    if (slot === undefined) {
      this.log("warning", "While manually checking if the sink has expired, the given media sink id does not have an active expiration timer.", sinkId);
      return;
    }
    if (slot.timer === undefined) {
      // the timer has already fired
      this.expireSink(sinkId);
      return;
    }
    // FireNow() and erase
    clearTimeout(slot.timer);
    this.expiry.delete(sinkId);
    this.onExpiration(sinkId);
  }

  // ----- routes

  private activeRoute(sinkId: string): AccessCodeRoute | undefined {
    return this.routes.current().find((r) => r.sinkId === sinkId);
  }

  /** `AccessCodeMediaRoutesObserver::OnRoutesUpdated`: when a route to one of our sinks ends, see whether it can expire. */
  private onRoutesUpdated(): void {
    if (this.disposed) return;
    const current = new Map(this.routes.current().map((r) => [r.id, r.sinkId]));
    const ended = new Set<string>();
    for (const [id, sinkId] of this.previousRoutes) if (!current.has(id)) ended.add(sinkId);
    this.previousRoutes = current;
    if (!this.enabled) return;
    for (const sinkId of ended) {
      // HandleMediaRouteRemovedByAccessCode: only sinks found by access code, and a pause first, because a sink often
      // ends one route and starts another straight away
      if (!this.kinds.has(sinkId) || this.host.sinkOf(sinkId) === undefined) continue;
      this.log("info", "An Access Code Cast route has ended.", sinkId);
      this.later(EXPIRATION_DELAY_MS, () => {
        // OnAccessCodeRouteRemoved: only if no route was set up again meanwhile
        if (this.activeRoute(sinkId) === undefined) this.checkMediaSinkForExpiration(sinkId);
      });
    }
  }

  // ----- start-up, network and settings

  private async load(): Promise<void> {
    let raw: unknown[];
    try {
      raw = await this.store.load();
    } catch (err) {
      this.log("error", `Failed to fetch stored devices: ${err instanceof Error ? err.message : String(err)}`, "");
      return;
    }
    let dropped = false;
    for (const value of Array.isArray(raw) ? raw : []) {
      const entry = parseRemembered(value);
      if (entry === undefined) {
        this.log("warning", "The media sink is missing from one or more of the pref services. Attempting to remove all sink_id references right now.", "");
        dropped = true;
      } else {
        this.entries.set(entry.id, entry);
      }
    }
    if (dropped) this.persist();
  }

  /** `InitAllStoredDevices`, `OnStoredDevicesValidated`: re-add what is remembered and start its timers. */
  private initAllStoredDevices(): void {
    const entries = [...this.entries.values()];
    if (entries.length === 0) {
      this.log("info", "There are no saved Access Code Cast devices for this profile.", "");
      return;
    }
    for (const entry of entries) void this.addSinkToMediaRouter(deviceOf(entry), "remembered");
    for (const entry of entries) this.setExpirationTimer(entry.id);
  }

  /** `RemoveAndDisconnectExistingSinksOnNetwork`: those with no route at all; a route keeps its sink while it lasts. */
  private removeAndDisconnectExistingSinksOnNetwork(): void {
    for (const sinkId of [...this.expiry.keys()]) {
      if (this.activeRoute(sinkId) !== undefined) continue;
      this.removeAndDisconnectMediaSinkFromRouter(sinkId);
    }
  }

  /** `OnDurationPrefChange`. */
  private onDurationChanged(): void {
    this.resetExpirationTimers();
    for (const id of this.entries.keys()) this.setExpirationTimer(id);
  }

  /** `OnEnabledPrefChange`, to false. */
  private onDisabled(): void {
    this.removeAndDisconnectExistingSinksOnNetwork();
    this.resetExpirationTimers();
    this.entries.clear();
    this.persist();
  }

  // ----- plumbing

  private later(ms: number, run: () => void): void {
    const t = setTimeout(() => {
      this.delayed.delete(t);
      if (!this.disposed) run();
    }, ms);
    t.unref?.();
    this.delayed.add(t);
  }

  private persist(): void {
    try {
      const done = this.store.save(this.remembered());
      if (done instanceof Promise) done.catch((err: unknown) => this.log("error", `Failed to store the sinks: ${String(err)}`, ""));
    } catch (err) {
      this.log("error", `Failed to store the sinks: ${err instanceof Error ? err.message : String(err)}`, "");
    }
  }

  private log(level: "info" | "warning" | "error", message: string, sinkId: string): void {
    try {
      this.logFn(level, message, sinkId);
    } catch {
      // a failing logger must not break casting
    }
  }
}

/** The policy is a non-negative integer (`AccessCodeCastDeviceDuration`: `minimum: 0`, type integer). */
function checkedDuration(seconds: number): number {
  if (!Number.isInteger(seconds) || seconds < 0) throw new RangeError("deviceDuration is a whole number of seconds, 0 or more");
  return seconds;
}

function memoryStore(): AccessCodeStore {
  let saved: AccessCodeRememberedSink[] = [];
  return { load: () => saved, save: (sinks) => void (saved = sinks) };
}
