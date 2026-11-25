// Opens and keeps a Cast channel to every discovered device and reports a device (a "sink") only while it has one, as
// Chrome's CastMediaSinkServiceImpl does (chrome/browser/media/router/discovery/mdns/cast_media_sink_service_impl.cc;
// docs/DESIGN.md lists each rule with its Chromium source). Nothing here is specific to an app.
import { EventEmitter } from "node:events";
import net from "node:net";
import type { CastDevice } from "../discovery/index.ts";
import type { CastClientLike, DeviceSource } from "./session-service.ts";

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
  /** For tests: a source of numbers in [0, 1). Default `Math.random`. */
  random?: () => number;
}

export interface CastSinkServiceOptions extends CastSinkOptions {
  source: DeviceSource;
  createClient(device: CastDevice): CastClientLike;
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
LOOPBACK.addAddress("::1", "ipv6");

/** `net::IPAddress::IsPubliclyRoutable`. An address that is not an IP literal counts as routable (it cannot be vetted). */
export function isPubliclyRoutable(host: string): boolean {
  const bare = host.split("%")[0] ?? host;
  if (net.isIPv4(bare)) return !IPV4_RESERVED.check(bare, "ipv4");
  if (net.isIPv6(bare)) {
    if (IPV6_PUBLIC.check(bare, "ipv6")) return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(bare);
    return mapped !== null && !IPV4_RESERVED.check(mapped[1] as string, "ipv4");
  }
  return true;
}

/** `net::IPAddress::IsLoopback`: 127.0.0.0/8 or ::1. */
export function isLoopback(host: string): boolean {
  const bare = host.split("%")[0] ?? host;
  if (net.isIPv4(bare)) return LOOPBACK.check(bare, "ipv4");
  if (net.isIPv6(bare)) return LOOPBACK.check(bare, "ipv6");
  return false;
}

const endpointOf = (device: CastDevice): string => `${device.host}:${device.port}`;

const sameDevice = (a: CastDevice, b: CastDevice): boolean => JSON.stringify(a) === JSON.stringify(b);

type OpenSource = "discovery" | "retry-on-error";

/**
 * The devices that have an open, authenticated channel. It is itself a {@link DeviceSource}: `devices()` and the
 * `deviceUp`/`deviceDown`/`deviceChanged` events describe that list (as MediaSinkServiceBase reports sinks), not what
 * mDNS has heard. A device appears once a channel to it has opened and passed device authentication; one that fails
 * authentication is retried like any other failure and never listed.
 */
export class CastSinkService extends EventEmitter<SinkEvents> implements DeviceSource {
  private readonly source: DeviceSource;
  private readonly createClient: (device: CastDevice) => CastClientLike;
  private readonly openDelayMaxMs: number;
  private readonly reportDelayMs: number;
  private readonly retry: Required<SinkRetryOptions>;
  private readonly allowAllIps: boolean;
  private readonly random: () => number;

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

  /**
   * Open channels now to every discovered device that has none, with no random delay (Chrome:
   * `CastMediaSinkService::DiscoverSinksNow`, which calls `OpenChannelsNow`). A device that gave up after its retries is
   * only tried again by this or when discovery reports it again.
   */
  discoverSinksNow(): void {
    this.openChannels("discovery");
  }

  /** Resolves when no channel is being opened and none is scheduled to be (retry waits do not count); for tests. */
  async settled(): Promise<void> {
    for (let i = 0; i < 1000 && (this.pending.size > 0 || this.reopening > 0 || this.batchTimer !== undefined || this.reportTimer !== undefined); i++) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
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
  private openChannel(device: CastDevice, source: OpenSource, failures: number): void {
    if (this.disposed) return;
    if (!this.allowAllIps && (isPubliclyRoutable(device.host) || isLoopback(device.host))) return;
    const endpoint = endpointOf(device);
    const existing = this.sinkMap.get(device.id);
    // A sink whose endpoint stayed the same needs no new channel, only its details updated (only discovery's: a retry
    // after an error reopens the channel).
    if (source !== "retry-on-error" && existing !== undefined && existing.endpoint === endpoint) {
      if (source === "discovery") this.updateSink(existing, device);
      return;
    }
    if (this.pending.has(endpoint)) return;
    this.pending.add(endpoint);
    let client: CastClientLike;
    try {
      client = this.createClient(device);
    } catch (err) {
      this.pending.delete(endpoint);
      this.onOpenError(device, source, failures, err);
      return;
    }
    client.connect().then(
      () => {
        this.pending.delete(endpoint);
        if (this.disposed) {
          client.close();
          return;
        }
        this.onOpened(device, client);
      },
      (err: unknown) => {
        this.pending.delete(endpoint);
        client.close();
        this.onOpenError(device, source, failures, err);
      },
    );
  }

  /** `OnChannelErrorMayRetry`: wait out the backoff and try again, or give up after `maxAttempts` failures in a row. */
  private onOpenError(device: CastDevice, source: OpenSource, failuresBefore: number, err: unknown): void {
    if (this.disposed) return;
    const error = err instanceof Error ? err : new Error(String(err));
    const failures = failuresBefore + 1;
    const giveUp = failures >= this.retry.maxAttempts;
    this.emit("openFailed", device, error, !giveUp);
    if (giveUp) {
      this.onOpenGaveUp(device);
      return;
    }
    // BackoffEntry::CalculateReleaseTime: initial * factor^(failures - 1), cut by up to `jitter`, at most the maximum
    const nominal = this.retry.initialDelayMs * this.retry.multiplyFactor ** (failures - 1);
    const delay = Math.min(nominal - this.random() * this.retry.jitter * nominal, this.retry.maxDelayMs);
    this.later(delay, () => this.openChannel(device, source, failures));
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
    // Chrome leaves the old socket to time out; ours is closed once a new channel to the device is open.
    if (previous?.client !== undefined && previous.client !== client) this.closeClient(previous);
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
    if (this.disposed || record.client !== client || this.sinkMap.get(record.device.id) !== record) return;
    record.client = undefined;
    this.emit("channelClosed", { device: record.device, client }, error);
    this.reopening += 1;
    this.later(0, () => {
      this.reopening -= 1;
      this.openChannel(this.latest(record.device), "retry-on-error", 0);
    });
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
