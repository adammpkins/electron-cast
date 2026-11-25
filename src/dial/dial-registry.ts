// SSDP discovery and the device registry, after DialServiceImpl and DialRegistry
// (chrome/browser/media/router/discovery/dial/dial_service_impl.cc and dial_registry.cc).
import { EventEmitter } from "node:events";
import { listIPv4Interfaces, type NetworkInterfaceInfo } from "../discovery/cast-discovery.ts";
import { buildSearchRequest, parseSsdpResponse, type DialDeviceData } from "./parse.ts";
import { openUdpSsdpSocket, type OpenSsdpSocket, type SsdpSocket } from "./ssdp-socket.ts";

export interface DialRegistryOptions {
  /** Interfaces to search on; default the external IPv4 addresses (the same set mDNS uses). */
  interfaces?: () => NetworkInterfaceInfo[];
  openSocket?: OpenSsdpSocket;
  /** The `USER-AGENT` of the search: `<product>/<version> <os>` (`BuildRequest`). */
  userAgent?: string;
  /** Epoch milliseconds; default `Date.now`. */
  now?: () => number;
  /** `kDialRefreshIntervalSecs` 120 s. */
  refreshMs?: number;
  /** `kDialExpirationSecs` 240 s. */
  expirationMs?: number;
  /** `kDialMaxDevices` 256. */
  maxDevices?: number;
  /** `kDialRequestIntervalMillis` 1000 ms between the searches of one cycle. */
  requestIntervalMs?: number;
  /** `kDialMaxRequests` 4 searches per cycle. */
  maxRequests?: number;
  /** `kDialResponseTimeoutSecs` 2 s after the last search before the cycle ends. */
  responseTimeoutMs?: number;
}

export interface DialRegistryEvents {
  /** The device list changed (or a forced discovery found it unchanged): `DialRegistry::MaybeSendDeviceList`. */
  deviceList: [devices: DialDeviceData[]];
  /** `DialRegistry::DialErrorCode` for what can go wrong here. */
  error: [code: "no_interfaces" | "socket_error", detail?: Error];
}

function defaultUserAgent(): string {
  return `Chrome/${process.versions.chrome ?? "0.0.0.0"} ${process.platform === "win32" ? "Windows" : process.platform === "darwin" ? "Mac OS X" : "Linux"}`;
}

/** Discovers DIAL devices by SSDP on every IPv4 interface and keeps those that keep answering. */
export class DialRegistry extends EventEmitter<DialRegistryEvents> {
  private readonly listIfaces: () => NetworkInterfaceInfo[];
  private readonly openSocketFn: OpenSsdpSocket;
  private readonly request: Buffer;
  private readonly now: () => number;
  private readonly refreshMs: number;
  private readonly expirationMs: number;
  private readonly maxDevices: number;
  private readonly requestIntervalMs: number;
  private readonly maxRequests: number;
  private readonly finishDelayMs: number;
  private readonly byId = new Map<string, DialDeviceData>();
  private sockets: SsdpSocket[] = [];
  private active = false;
  private sent = 0;
  /** Bumped by every change of the list (and by each discovery that was asked for), like `registry_generation_`. */
  private generation = 0;
  private lastSentGeneration = 0;
  private labelCount = 0;
  private cycle = 0;
  private timers: NodeJS.Timeout[] = [];
  private refreshTimer: NodeJS.Timeout | null = null;
  private started = false;
  private stopped = false;

  constructor(options: DialRegistryOptions = {}) {
    super();
    this.listIfaces = options.interfaces ?? (() => listIPv4Interfaces());
    this.openSocketFn = options.openSocket ?? openUdpSsdpSocket;
    this.request = Buffer.from(buildSearchRequest(options.userAgent ?? defaultUserAgent()), "latin1");
    this.now = options.now ?? Date.now;
    this.refreshMs = options.refreshMs ?? 120_000;
    this.expirationMs = options.expirationMs ?? 240_000;
    this.maxDevices = options.maxDevices ?? 256;
    this.requestIntervalMs = options.requestIntervalMs ?? 1000;
    this.maxRequests = options.maxRequests ?? 4;
    // `finish_delay_`: (kDialMaxRequests - 1) intervals plus the response timeout.
    this.finishDelayMs = (this.maxRequests - 1) * this.requestIntervalMs + (options.responseTimeoutMs ?? 2000);
  }

  /** `DialRegistry::StartPeriodicDiscovery`: one cycle now, then one every `refreshMs`. */
  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    this.discover();
    this.refreshTimer = setInterval(() => this.discover(), this.refreshMs);
    this.refreshTimer.unref?.();
    // The current list goes out with the next request even if it is empty, as in Chromium.
    this.generation++;
  }

  /** `DialRegistry::DiscoverNow`: starts a cycle unless one is running; the list is then sent even if unchanged. */
  discoverNow(): boolean {
    if (!this.started || this.stopped) return false;
    const started = this.discover();
    if (started) this.generation++;
    return started;
  }

  /** The devices currently registered, with their labels. */
  devices(): DialDeviceData[] {
    return [...this.byId.values()].map((d) => ({ ...d }));
  }

  /** Stops searching and forgets the devices. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.refreshTimer !== null) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
    this.endCycle();
    this.byId.clear();
  }

  /** `DialServiceImpl::Discover`. Returns false when a cycle is already running. */
  private discover(): boolean {
    if (this.active || this.stopped) return false;
    this.active = true;
    const cycle = ++this.cycle;
    let ifaces: NetworkInterfaceInfo[];
    try {
      ifaces = this.listIfaces();
    } catch {
      ifaces = [];
    }
    if (ifaces.length === 0) {
      this.emit("error", "no_interfaces");
      this.finish(cycle);
      return true;
    }
    this.timers.push(setTimeout(() => this.finish(cycle), this.finishDelayMs));
    void Promise.allSettled(ifaces.map((iface) => this.bind(iface, cycle))).then(() => {
      if (cycle !== this.cycle || !this.active) return;
      if (this.sockets.length === 0) this.emit("error", "no_interfaces");
      this.sendOne(cycle);
    });
    return true;
  }

  private async bind(iface: NetworkInterfaceInfo, cycle: number): Promise<void> {
    let socket: SsdpSocket;
    try {
      socket = await this.openSocketFn(iface, {
        message: (packet, from) => this.onPacket(packet, from, cycle),
        error: (error) => this.emit("error", "socket_error", error),
      });
    } catch (error) {
      this.emit("error", "socket_error", error instanceof Error ? error : new Error(String(error)));
      return;
    }
    if (cycle !== this.cycle || !this.active) {
      socket.close();
      return;
    }
    this.sockets.push(socket);
  }

  /** `SendOneRequest`: one search on every open socket, then the next after the interval. */
  private sendOne(cycle: number): void {
    if (cycle !== this.cycle || !this.active) return;
    if (this.sent >= this.maxRequests) return;
    this.sent++;
    for (const socket of this.sockets) {
      try {
        socket.send(this.request);
      } catch (error) {
        this.emit("error", "socket_error", error instanceof Error ? error : new Error(String(error)));
      }
    }
    this.maybeSendList();
    if (this.sent < this.maxRequests) this.timers.push(setTimeout(() => this.sendOne(cycle), this.requestIntervalMs));
  }

  private onPacket(packet: Buffer, from: { address: string; port: number }, cycle: number): void {
    // Chromium reads into a 1500-byte buffer and drops what would not fit.
    if (!this.active || cycle !== this.cycle || packet.length > 1500) return;
    const device = parseSsdpResponse(packet.toString("latin1"), from.address, this.now());
    if (device !== null) this.onDeviceDiscovered(device);
  }

  private onDeviceDiscovered(device: DialDeviceData): void {
    const known = this.byId.get(device.deviceId);
    if (known === undefined) {
      if (this.byId.size >= this.maxDevices) return;
      device.label = String(++this.labelCount);
      this.byId.set(device.deviceId, device);
      this.generation++;
      return;
    }
    // `DialDeviceData::UpdateFrom`: the new answer replaces the old; only some fields count as a change.
    const changed = known.descriptionUrl !== device.descriptionUrl || known.configId !== device.configId
      || known.ipAddress !== device.ipAddress || known.maxAge !== device.maxAge;
    device.label = known.label;
    this.byId.set(device.deviceId, device);
    if (changed) this.generation++;
  }

  /** `DialServiceImpl::FinishDiscovery`, then `DialRegistry::OnDiscoveryFinished`. */
  private finish(cycle: number): void {
    if (cycle !== this.cycle) return;
    this.endCycle();
    if (this.prune()) this.generation++;
    this.maybeSendList();
  }

  private endCycle(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    for (const s of this.sockets) {
      try {
        s.close();
      } catch {
        // already closed
      }
    }
    this.sockets = [];
    this.sent = 0;
    this.active = false;
  }

  /** `PruneExpiredDevices` / `IsDeviceExpired`: the default lifetime, or the answer's own max-age if shorter. */
  private prune(): boolean {
    const now = this.now();
    let pruned = false;
    for (const [id, device] of this.byId) {
      const expired = now > device.responseTime + this.expirationMs
        || (device.maxAge !== null && now > device.responseTime + device.maxAge * 1000);
      if (expired) {
        this.byId.delete(id);
        pruned = true;
      }
    }
    return pruned;
  }

  private maybeSendList(): void {
    if (this.lastSentGeneration >= this.generation) return;
    this.lastSentGeneration = this.generation;
    this.emit("deviceList", this.devices());
  }
}
