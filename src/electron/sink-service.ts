// Opens and keeps a Cast channel to every discovered device and reports a device (a "sink") only while it has one, as
// Chrome's CastMediaSinkServiceImpl does (chrome/browser/media/router/discovery/mdns/cast_media_sink_service_impl.cc;
// docs/DESIGN.md lists each rule with its Chromium source). Nothing here is specific to an app.
import { EventEmitter } from "node:events";
import net from "node:net";
import type { CastDevice } from "../discovery/index.ts";
import type { CastClientLike, DeviceSource } from "./session-service.ts";

/** How a channel is opened (Chrome: `CastSocketOpenParams`, built by `CreateCastSocketOpenParams`). */
export interface ChannelParams {
  /** Connect timeout (TLS handshake and authentication reply). 10 s, longer after failures when a delta is set. */
  connectTimeoutMs: number;
  /** Idle time without a reply before the channel is declared dead. 10 s, longer after failures when a delta is set. */
  livenessTimeoutMs: number;
  /** Idle time before the device is pinged (Chrome: `ping_interval_in_seconds`). 5 s; 4 s for a device added by access code. */
  pingIntervalMs: number;
}

/** A device and the open channel to it. */
export interface SinkChannel {
  device: CastDevice;
  client: CastClientLike;
}

/**
 * Retry policy for opening a channel (Chrome: `CastMediaSinkServiceImpl::RetryParams` and the `BackoffEntry` policy
 * built in its constructor). The defaults are Chrome's; they are exposed for tests.
 */
export interface SinkRetryOptions {
  /** Delay before the first retry; later ones multiply by `multiplyFactor`. Default 15000 (`initial_delay_in_milliseconds`). */
  initialDelayMs?: number;
  /** Attempts in a row before the device is given up on. Default 3 (`max_retry_attempts`). */
  maxAttempts?: number;
  /** Default 1 (`multiply_factor`). */
  multiplyFactor?: number;
  /** A delay is cut by up to this fraction at random. Default 0.5 (the policy's `jitter_factor`). */
  jitter?: number;
  /** Default 30000 (the policy's `maximum_backoff_ms`). */
  maxDelayMs?: number;
}

/** What the sink service does when and how; the defaults follow Chrome. */
export interface CastSinkOptions {
  /**
   * After discovery reports devices, channels open after a random delay of up to this many ms, so several apps do not
   * hit one receiver at once. Default 5000 (`OpenChannelsWithRandomizedDelay`).
   */
  openDelayMaxMs?: number;
  /** Changes to the list of devices are reported once this quiet. Default 3000 (`kDiscoveryTimeout` in `MediaSinkServiceBase`). */
  reportDelayMs?: number;
  retry?: SinkRetryOptions;
  /**
   * Open channels to publicly routable and loopback addresses too. Default false: Chrome refuses them unless its
   * `kMediaRouterCastAllowAllIPs` policy is set (`CastMediaSinkServiceImpl::OpenChannel`). Mind that device addresses
   * come from mDNS, which anyone on the network can answer.
   */
  allowAllIps?: boolean;
  /**
   * Added to the connect and liveness timeouts for each failed attempt on a device, up to 30 s and 60 s. Default 0, as in
   * Chrome (`OpenParams::dynamic_timeout_delta_in_seconds` is 0 and nothing sets it), so the timeouts stay 10 s.
   */
  dynamicTimeoutDeltaMs?: number;
  /** For tests: a source of numbers in [0, 1). Default `Math.random`. */
  random?: () => number;
}

export interface CastSinkServiceOptions extends CastSinkOptions {
  source: DeviceSource;
  createClient(device: CastDevice, params: ChannelParams): CastClientLike;
  /**
   * Whether something still uses a client the sink no longer lists. A replaced channel is not closed while it is in use
   * (Chrome leaves the old socket alone, so a session on it goes on); call {@link CastSinkService.releaseUnused} when
   * that may have changed. Default: nothing uses it.
   */
  isClientInUse?(client: CastClientLike): boolean;
}

interface SinkRecord {
  device: CastDevice;
  /** Undefined while the channel is down and being reopened (Chrome keeps the sink listed meanwhile). */
  client: CastClientLike | undefined;
  endpoint: string;
}

interface SinkEvents {
  deviceUp: [device: CastDevice];
  deviceDown: [device: CastDevice];
  deviceChanged: [device: CastDevice];
  /** A channel opened (after device authentication); the sink is in `sinks()` but may not be reported yet. */
  channelOpened: [channel: SinkChannel];
  /** An open channel failed (keep-alive timeout, remote close...); a reopen follows. The sink stays until that gives up. */
  channelClosed: [channel: SinkChannel, error: Error | undefined];
  /** The sink left the list because its channel could not be reopened. */
  sinkRemoved: [device: CastDevice];
  /** A discovered device was left alone: its address is not an IP address a channel may be opened to. */
  skipped: [device: CastDevice, reason: string];
  /** The sink has a new channel; this one is no longer its own and is closed once nothing uses it. */
  channelRetired: [client: CastClientLike];
  /** An attempt to open a channel failed (it may be retried). */
  openFailed: [device: CastDevice, error: Error, willRetry: boolean];
}

const IPV4_RESERVED = new net.BlockList();
// kReservedIPv4Ranges in net/base/ip_address.cc
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 3],
] as const) {
  IPV4_RESERVED.addSubnet(address, prefix, "ipv4");
}
const IPV6_PUBLIC = new net.BlockList();
// kPublicIPv6Ranges in net/base/ip_address.cc: global unicast and multicast
IPV6_PUBLIC.addSubnet("2000::", 3, "ipv6");
IPV6_PUBLIC.addSubnet("ff00::", 8, "ipv6");

const LOOPBACK = new net.BlockList();
LOOPBACK.addSubnet("127.0.0.0", 8, "ipv4");

/** `net::IPAddress::IsPubliclyRoutable`. An address that is not an IP literal counts as routable (it cannot be vetted). */
export function isPubliclyRoutable(host: string): boolean {
  const bare = host.split("%")[0] ?? host;
  if (net.isIPv4(bare)) return !IPV4_RESERVED.check(bare, "ipv4");
  if (net.isIPv6(bare)) {
    if (IPV6_PUBLIC.check(bare, "ipv6")) return true;
    // IsPubliclyRoutableIPv6: an IPv4-mapped address is as routable as the IPv4 address in it. The URL parser gives one
    // form whatever way it was written (::ffff:8.8.8.8, ::ffff:808:808, 0:0:0:0:0:ffff:808:808), so match that.
    const mapped = IPV4_MAPPED.exec(canonicalIPv6(bare));
    if (mapped === null) return false;
    const high = parseInt(mapped[1] as string, 16);
    const low = parseInt(mapped[2] as string, 16);
    return !IPV4_RESERVED.check(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`, "ipv4");
  }
  return true;
}

const IPV4_MAPPED = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/;

/** The compressed lower-case form of an IPv6 literal, as the URL parser writes it. */
function canonicalIPv6(address: string): string {
  try {
    return new URL(`http://[${address}]`).hostname.slice(1, -1);
  } catch {
    return address.toLowerCase();
  }
}

/** `net::IPAddress::IsLoopback`: 127.0.0.0/8 or ::1. */
export function isLoopback(host: string): boolean {
  const bare = host.split("%")[0] ?? host;
  if (net.isIPv4(bare)) return LOOPBACK.check(bare, "ipv4");
  // ::1 only: node's BlockList would also match ::ffff:127.0.0.1 against 127/8, which IsLoopback does not
  if (net.isIPv6(bare)) return canonicalIPv6(bare) === "::1";
  return false;
}

const endpointOf = (device: CastDevice): string => `${device.host}:${device.port}`;

const sameDevice = (a: CastDevice, b: CastDevice): boolean => JSON.stringify(a) === JSON.stringify(b);

type OpenSource = "discovery" | "retry-on-error" | "access-code";

/** The delays between attempts (`BackoffEntry`'s policy); the number of attempts is the service's `retry.maxAttempts`. */
export type OpenBackoff = Required<Omit<SinkRetryOptions, "maxAttempts">>;

/** What a caller of {@link CastSinkService.openSink} may change about the run of attempts to open a channel. */
export interface OpenSinkOptions {
  /** Timeouts for the channel, instead of the service's own (Chrome: the `CastSocketOpenParams` passed to `OpenChannel`). */
  params?: ChannelParams;
  /** Delays between attempts, instead of the service's `retry` (Chrome: the `BackoffEntry` passed to `OpenChannel`). */
  backoff?: OpenBackoff;
}

/** Carries one run of attempts: its options and who to tell how it ended (Chrome's `ChannelOpenedCallback`). */
interface OpenContext extends OpenSinkOptions {
  done?: (opened: boolean, error?: Error) => void;
}

const MAX_CONNECT_TIMEOUT_MS = 30_000;
const MAX_LIVENESS_TIMEOUT_MS = 60_000;
const MAX_FAILURE_COUNT = 100;

/**
 * Whether a sink's endpoint is still one of the device's addresses. mDNS lists a device's addresses in no fixed order, so
 * a reorder alone is no reason to replace a working channel (Chrome has one address per record, so there is no
 * counterpart; a changed address does replace the endpoint there, `OpenChannel`).
 */
function endpointStillOffered(endpoint: string, device: CastDevice): boolean {
  const cut = endpoint.lastIndexOf(":");
  const host = endpoint.slice(0, cut);
  return Number(endpoint.slice(cut + 1)) === device.port && (device.host === host || device.addresses.includes(host));
}

/**
 * The devices that have an open, authenticated channel. It is itself a {@link DeviceSource}: `devices()` and the
 * `deviceUp`/`deviceDown`/`deviceChanged` events describe that list (as MediaSinkServiceBase reports sinks), not what
 * mDNS has heard. A device appears once a channel to it has opened and passed device authentication; one that fails
 * authentication is retried like any other failure and never listed.
 */
export class CastSinkService extends EventEmitter<SinkEvents> implements DeviceSource {
  private readonly source: DeviceSource;
  private readonly createClient: (device: CastDevice, params: ChannelParams) => CastClientLike;
  private readonly openDelayMaxMs: number;
  private readonly reportDelayMs: number;
  private readonly retry: Required<SinkRetryOptions>;
  private readonly allowAllIps: boolean;
  private readonly random: () => number;
  private readonly dynamicTimeoutDeltaMs: number;
  private readonly isClientInUse: (client: CastClientLike) => boolean;
  /** Failed attempts per device since its last success, as `failure_count_map_`. */
  private readonly failureCounts = new Map<string, number>();
  /** Clients of replaced channels that were in use when replaced. */
  private readonly retired = new Set<CastClientLike>();
  private readonly warned = new Set<string>();
  /** The last error of each device whose channel is not open, for explaining an empty list. */
  private readonly lastErrors = new Map<string, string>();

  /** Sinks as they are now (Chrome: `GetSinks()`), keyed by device id. */
  private readonly sinkMap = new Map<string, SinkRecord>();
  /** Sinks as last reported (Chrome: `previous_sinks_`). */
  private reported = new Map<string, CastDevice>();
  /** Endpoints with a channel being opened (Chrome: `pending_for_open_ip_endpoints_`). */
  private readonly pending = new Set<string>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private reportTimer: ReturnType<typeof setTimeout> | undefined;
  private batchTimer: ReturnType<typeof setTimeout> | undefined;
  private reopening = 0;
  /** Callers of {@link openSink} still waiting; they are told "not opened" on `dispose()`. */
  private readonly waiting = new Set<(opened: boolean) => void>();
  private disposed = false;
  private readonly onSourceEvent = (): void => this.openChannelsWithRandomizedDelay();

  constructor(options: CastSinkServiceOptions) {
    super();
    this.source = options.source;
    this.createClient = options.createClient;
    this.openDelayMaxMs = options.openDelayMaxMs ?? 5000;
    this.reportDelayMs = options.reportDelayMs ?? 3000;
    this.allowAllIps = options.allowAllIps ?? false;
    this.random = options.random ?? Math.random;
    this.dynamicTimeoutDeltaMs = options.dynamicTimeoutDeltaMs ?? 0;
    this.isClientInUse = options.isClientInUse ?? (() => false);
    const r = options.retry ?? {};
    this.retry = {
      initialDelayMs: r.initialDelayMs ?? 15000,
      maxAttempts: r.maxAttempts ?? 3,
      multiplyFactor: r.multiplyFactor ?? 1,
      jitter: r.jitter ?? 0.5,
      maxDelayMs: r.maxDelayMs ?? 30000,
    };
    this.source.on("deviceUp", this.onSourceEvent);
    this.source.on("deviceChanged", this.onSourceEvent);
    // Chrome opens channels for what discovery already knows when it starts (`Start()` then the first DNS-SD event).
    if (this.source.devices().length > 0) this.openChannelsWithRandomizedDelay();
  }

  /** The devices as last reported. */
  devices(): CastDevice[] {
    return [...this.reported.values()].map((d) => ({ ...d }));
  }

  /** The current sinks, reported or not (Chrome: `GetSinks()`); the tracker and sessions use these. */
  sinks(): CastDevice[] {
    return [...this.sinkMap.values()].map((s) => ({ ...s.device }));
  }

  /** The open channel's client for a device; undefined when it has none right now. */
  clientOf(deviceId: string): CastClientLike | undefined {
    return this.sinkMap.get(deviceId)?.client;
  }

  /** The device (as a sink) with this id, if it is one now. */
  sinkOf(deviceId: string): CastDevice | undefined {
    const rec = this.sinkMap.get(deviceId);
    return rec === undefined ? undefined : { ...rec.device };
  }

  /** Whether a device is a sink now (Chrome: `CastMediaSinkServiceImpl::HasSink`). */
  hasSink(deviceId: string): boolean {
    return this.sinkMap.has(deviceId);
  }

  /**
   * Open a channel to a device that discovery did not report, and list it once the channel has opened and authenticated
   * (what `AccessCodeCastSinkService` does through `CastMediaSinkServiceImpl::OpenChannel`). Resolves true when the sink
   * has a channel, false when none could be opened: the address is not one a channel may be opened to, the attempts ran
   * out, or the service was disposed. Failed attempts are retried as discovery's are, with `options.backoff` between them.
   */
  openSink(device: CastDevice, options: OpenSinkOptions = {}): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      if (this.disposed) {
        resolve(false);
        return;
      }
      this.waiting.add(resolve);
      this.openChannel(device, "access-code", 0, {
        ...options,
        done: (opened) => {
          this.waiting.delete(resolve);
          resolve(opened);
        },
      });
    });
  }

  /** A sink takes a new name and capabilities (Chrome: `AddOrUpdateSink` on a copy of the existing sink, as `UpdateExistingSink` does). */
  updateSinkDetails(deviceId: string, details: { name: string; capabilities: number }): void {
    const record = this.sinkMap.get(deviceId);
    if (record === undefined) return;
    const next: CastDevice = { ...record.device, name: details.name, capabilities: details.capabilities };
    if (sameDevice(next, record.device)) return;
    record.device = next;
    this.markChanged();
  }

  /** Remove a sink and close its channel (Chrome: `CastMediaSinkServiceImpl::DisconnectAndRemoveSink`). */
  disconnectAndRemoveSink(deviceId: string): void {
    const record = this.sinkMap.get(deviceId);
    if (record !== undefined) this.removeSink(record);
  }

  /**
   * Open channels now to every discovered device that has none, with no random delay (Chrome:
   * `CastMediaSinkService::DiscoverSinksNow`, which calls `OpenChannelsNow`). A device that gave up after its retries is
   * only tried again by this or when discovery reports it again.
   */
  discoverSinksNow(): void {
    this.openChannels("discovery");
  }

  /**
   * Resolves when no channel is being opened and none is scheduled to be; for tests. A retry waiting out its backoff does
   * not count unless `retries` is set (a real backoff is 15 s).
   */
  async settled(options: { retries?: boolean } = {}): Promise<void> {
    const busy = (): boolean =>
      this.pending.size > 0 || this.reopening > 0 || this.batchTimer !== undefined || this.reportTimer !== undefined ||
      (options.retries === true && this.timers.size > 0);
    for (let i = 0; i < 2000 && busy(); i++) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  }

  /** The distinct errors of the devices that could not be opened, none for a device that has since opened. */
  openErrors(): string[] {
    return [...new Set(this.lastErrors.values())];
  }

  /** Close the clients of replaced channels that nothing uses any more. */
  releaseUnused(): void {
    for (const client of [...this.retired]) {
      if (this.isClientInUse(client)) continue;
      this.retired.delete(client);
      this.closeQuietly(client);
    }
  }

  private closeQuietly(client: CastClientLike): void {
    try {
      client.close();
    } catch {
      // already closed
    }
  }

  /** `CreateCastSocketOpenParams`: the timeouts for the next run of attempts on a device. */
  private paramsFor(deviceId: string): ChannelParams {
    const failures = this.failureCounts.get(deviceId) ?? 0;
    const grow = failures * this.dynamicTimeoutDeltaMs;
    return {
      connectTimeoutMs: Math.min(10_000 + grow, MAX_CONNECT_TIMEOUT_MS),
      livenessTimeoutMs: Math.min(10_000 + grow, MAX_LIVENESS_TIMEOUT_MS),
      pingIntervalMs: 5000,
    };
  }

  /** Stop everything and close every channel. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.source.off("deviceUp", this.onSourceEvent);
    this.source.off("deviceChanged", this.onSourceEvent);
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.reopening = 0;
    if (this.batchTimer !== undefined) clearTimeout(this.batchTimer);
    if (this.reportTimer !== undefined) clearTimeout(this.reportTimer);
    this.batchTimer = this.reportTimer = undefined;
    const records = [...this.sinkMap.values()];
    this.sinkMap.clear();
    this.reported.clear();
    for (const rec of records) this.closeClient(rec);
    for (const client of this.retired) this.closeQuietly(client);
    this.retired.clear();
    for (const resolve of [...this.waiting]) resolve(false);
    this.waiting.clear();
    this.removeAllListeners();
  }

  private later(ms: number, run: () => void): void {
    const t = setTimeout(() => {
      this.timers.delete(t);
      run();
    }, ms);
    t.unref?.();
    this.timers.add(t);
  }

  /** `OpenChannelsWithRandomizedDelay`; calls arriving while one is waiting are covered by it, as it reads the list when it runs. */
  private openChannelsWithRandomizedDelay(): void {
    if (this.disposed || this.batchTimer !== undefined) return;
    this.batchTimer = setTimeout(() => {
      this.batchTimer = undefined;
      this.openChannels("discovery");
    }, this.random() * this.openDelayMaxMs);
    this.batchTimer.unref?.();
  }

  private openChannels(source: OpenSource): void {
    if (this.disposed) return;
    for (const device of this.source.devices()) this.openChannel(device, source, 0);
  }

  /** `CastMediaSinkServiceImpl::OpenChannel`. `failures` counts the failed attempts so far in this run of retries. */
  private openChannel(device: CastDevice, source: OpenSource, failures: number, ctx: OpenContext = {}): void {
    if (this.disposed) {
      ctx.done?.(false);
      return;
    }
    if (!net.isIP(device.host.split("%")[0] ?? device.host)) {
      // Chrome opens channels to IP endpoints only (`IPEndPoint`), and a name cannot be vetted against the address rules.
      this.skip(device, `"${device.host}" is a host name, not an IP address; a channel is opened to IP addresses only`);
      ctx.done?.(false);
      return;
    }
    if (!this.allowAllIps && (isPubliclyRoutable(device.host) || isLoopback(device.host))) {
      this.skip(device, `${device.host} is ${isLoopback(device.host) ? "a loopback" : "a publicly routable"} address (allowAllIps is off)`);
      ctx.done?.(false);
      return;
    }
    const existing = this.sinkMap.get(device.id);
    // The sink's own endpoint stays while the device still offers it, so an address list reordered by mDNS does not
    // replace a channel that works.
    if (source === "discovery" && existing !== undefined && endpointStillOffered(existing.endpoint, device)) {
      device = { ...device, host: existing.device.host, port: existing.device.port };
    }
    const endpoint = endpointOf(device);
    // A sink whose endpoint stayed the same needs no new channel, only its details updated (only discovery's: a retry
    // after an error reopens the channel).
    if (source !== "retry-on-error" && existing !== undefined && existing.endpoint === endpoint) {
      if (source === "discovery") this.updateSink(existing, device);
      ctx.done?.(true);
      return;
    }
    if (this.pending.has(endpoint)) {
      ctx.done?.(false);
      return;
    }
    this.pending.add(endpoint);
    const run: OpenContext = { ...ctx, params: ctx.params ?? this.paramsFor(device.id) };
    const openParams = run.params as ChannelParams;
    let client: CastClientLike;
    try {
      client = this.createClient(device, openParams);
    } catch (err) {
      this.pending.delete(endpoint);
      this.onOpenError(device, source, failures, err, run);
      return;
    }
    client.connect().then(
      () => {
        this.pending.delete(endpoint);
        if (this.disposed) {
          client.close();
          run.done?.(false);
          return;
        }
        this.onOpened(device, client);
        run.done?.(true);
      },
      (err: unknown) => {
        this.pending.delete(endpoint);
        client.close();
        this.onOpenError(device, source, failures, err, run);
      },
    );
  }

  /** `OnChannelErrorMayRetry`: wait out the backoff and try again, or give up after `maxAttempts` failures in a row. */
  private onOpenError(device: CastDevice, source: OpenSource, failuresBefore: number, err: unknown, run: OpenContext): void {
    if (this.disposed) {
      run.done?.(false);
      return;
    }
    this.failureCounts.set(device.id, Math.min((this.failureCounts.get(device.id) ?? 0) + 1, MAX_FAILURE_COUNT));
    const error = err instanceof Error ? err : new Error(String(err));
    this.lastErrors.set(device.id, error.message);
    const failures = failuresBefore + 1;
    const giveUp = failures >= this.retry.maxAttempts;
    this.emit("openFailed", device, error, !giveUp);
    if (giveUp) {
      this.onOpenGaveUp(device);
      run.done?.(false, error);
      return;
    }
    // BackoffEntry::CalculateReleaseTime: initial * factor^(failures - 1), cut by up to `jitter`, at most the maximum
    const backoff = run.backoff ?? this.retry;
    const nominal = backoff.initialDelayMs * backoff.multiplyFactor ** (failures - 1);
    const delay = Math.min(nominal - this.random() * backoff.jitter * nominal, backoff.maxDelayMs);
    const endpoint = endpointOf(device);
    this.later(delay, () => {
      // A retry captured an endpoint; if the device has meanwhile been reached at another one, or discovery now names
      // another, the newer attempt is the one that counts (Chrome's `OnChannelOpenFailed` ignores a failure whose
      // endpoint is no longer the sink's for the same reason).
      const now = this.sinkMap.get(device.id);
      const offered = this.source.devices().find((d) => d.id === device.id);
      if ((now !== undefined && now.endpoint !== endpoint) || (offered !== undefined && !endpointStillOffered(endpoint, offered))) {
        run.done?.(false);
        return;
      }
      this.openChannel(device, source, failures, run);
    });
  }

  /** `OnChannelOpenFailed`: drop the sink, unless it was meanwhile reconnected at another address. */
  private onOpenGaveUp(device: CastDevice): void {
    const existing = this.sinkMap.get(device.id);
    if (existing === undefined || existing.endpoint !== endpointOf(device)) return;
    this.removeSink(existing);
  }

  /** `OnChannelOpenSucceeded`. */
  private onOpened(device: CastDevice, client: CastClientLike): void {
    const endpoint = endpointOf(device);
    const previous = this.sinkMap.get(device.id);
    const record: SinkRecord = { device: { ...device }, client, endpoint };
    this.failureCounts.delete(device.id);
    this.lastErrors.delete(device.id);
    // Chrome leaves the old socket alone when a sink gets a new one (`OnChannelOpenSucceeded` only adds the sink with
    // the new channel id), so a session on it goes on; ours is closed once no session uses it.
    const old = previous?.client;
    if (previous !== undefined) previous.client = undefined;
    if (old !== undefined && old !== client) {
      if (this.isClientInUse(old)) this.retired.add(old);
      else this.closeQuietly(old);
      this.emit("channelRetired", old);
    }
    this.sinkMap.set(device.id, record);
    // An address appears in at most one sink: a sink with another id at this address is stale.
    for (const other of [...this.sinkMap.values()]) {
      if (other !== record && other.endpoint === endpoint) this.removeSink(other);
    }
    client.on("close", (error?: Error) => this.onClientClosed(record, client, error));
    this.markChanged();
    this.emit("channelOpened", { device: record.device, client });
  }

  /** `OnError` of the cast socket observer: the channel failed, so reopen it (as a retry after an error). */
  private onClientClosed(record: SinkRecord, client: CastClientLike, error: Error | undefined): void {
    this.retired.delete(client);
    if (this.disposed || record.client !== client || this.sinkMap.get(record.device.id) !== record) return;
    record.client = undefined;
    this.emit("channelClosed", { device: record.device, client }, error);
    this.reopening += 1;
    this.later(0, () => {
      this.reopening -= 1;
      this.openChannel(this.reopenTarget(record), "retry-on-error", 0);
    });
  }

  /** The device to reopen: as discovery knows it now, at the sink's own endpoint while the device still offers it. */
  private reopenTarget(record: SinkRecord): CastDevice {
    const fresh = this.latest(record.device);
    return endpointStillOffered(record.endpoint, fresh) ? { ...fresh, host: record.device.host, port: record.device.port } : fresh;
  }

  private skip(device: CastDevice, reason: string): void {
    const key = `${device.id} ${reason}`;
    if (!this.warned.has(key)) {
      this.warned.add(key);
      console.warn(`electron-cast: no channel is opened to device ${device.id}: ${reason}`);
    }
    this.emit("skipped", device, reason);
  }

  /** The device as discovery knows it now (its address may have changed), else as it was. */
  private latest(device: CastDevice): CastDevice {
    return this.source.devices().find((d) => d.id === device.id) ?? device;
  }

  /** `UpdateCastSink`: a sink already open takes its new name and capabilities. */
  private updateSink(record: SinkRecord, fresh: CastDevice): void {
    const next: CastDevice = { ...fresh, host: record.device.host, addresses: record.device.addresses, port: record.device.port };
    if (sameDevice(next, record.device)) return;
    record.device = next;
    this.markChanged();
  }

  private removeSink(record: SinkRecord): void {
    if (this.sinkMap.get(record.device.id) !== record) return;
    this.sinkMap.delete(record.device.id);
    this.closeClient(record);
    this.markChanged();
    this.emit("sinkRemoved", record.device);
  }

  /** Close a record's client without the close being taken for a channel error. */
  private closeClient(record: SinkRecord): void {
    const client = record.client;
    record.client = undefined;
    try {
      client?.close();
    } catch {
      // already closed
    }
  }

  /** `MediaSinkServiceBase::StartTimer`: the changed list is reported once discovery has been quiet for a while. */
  private markChanged(): void {
    if (this.disposed || this.reportTimer !== undefined) return;
    this.reportTimer = setTimeout(() => {
      this.reportTimer = undefined;
      this.report();
    }, this.reportDelayMs);
    this.reportTimer.unref?.();
  }

  /** `OnDiscoveryComplete`: report only if the list differs from the one last reported. */
  private report(): void {
    if (this.disposed) return;
    const next = new Map<string, CastDevice>();
    for (const rec of this.sinkMap.values()) next.set(rec.device.id, { ...rec.device });
    const previous = this.reported;
    this.reported = next;
    for (const [id, device] of previous) {
      if (!next.has(id)) this.emit("deviceDown", { ...device });
    }
    for (const [id, device] of next) {
      const before = previous.get(id);
      if (before === undefined) this.emit("deviceUp", { ...device });
      else if (!sameDevice(before, device)) this.emit("deviceChanged", { ...device });
    }
  }
}
