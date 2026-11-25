import { EventEmitter } from "node:events";
import os from "node:os";
import { CastDeviceCache, type CacheChange, type CastDevice } from "./device-cache.ts";
import { decodeDnsPacket, encodeMdnsQuery, RecordType, type DnsPacket, type DnsRecord } from "./dns-packet.ts";
import { openUdpMdnsSocket } from "./udp-socket.ts";

/**
 * An interface mDNS runs on. `family` is "IPv4" when absent. For "IPv6" it is the interface's link-local address
 * and `scopeId` its zone. An IPv4 entry may carry the `scopeId` of the same adapter's link-local address, so
 * link-local AAAA records heard on it can be turned into addresses that can be connected to (`fe80::1%12`).
 */
export interface NetworkInterfaceInfo { name: string; address: string; family?: "IPv4" | "IPv6"; scopeId?: number }

/** Callbacks for an mDNS socket: incoming packets and socket errors. */
export interface MdnsSocketHandlers {
  message(packet: Buffer, from: { address: string; port: number }): void;
  error(error: Error): void;
}

/** An open mDNS socket: send queries on it, close it when done. */
export interface MdnsSocket { send(packet: Buffer): void; close(): void }

/** Opens an mDNS socket on one interface; rejects if it cannot. */
export type OpenMdnsSocket = (iface: NetworkInterfaceInfo, handlers: MdnsSocketHandlers) => Promise<MdnsSocket>;

const DEFAULT_SERVICE_NAME = "_googlecast._tcp.local";

/**
 * External IPv4 interfaces: non-internal, non-link-local, one entry per
 * address (first name wins), in the order the OS reports them.
 */
export function listIPv4Interfaces(nets?: NodeJS.Dict<os.NetworkInterfaceInfo[]>): NetworkInterfaceInfo[] {
  const out: NetworkInterfaceInfo[] = [];
  const seen = new Set<string>();
  for (const [name, addrs] of Object.entries(nets ?? os.networkInterfaces())) {
    for (const addr of addrs ?? []) {
      const family: unknown = addr.family;
      if (family !== "IPv4" && family !== 4) continue;
      if (addr.internal) continue;
      if (addr.address.startsWith("169.254.")) continue;
      if (seen.has(addr.address)) continue;
      seen.add(addr.address);
      out.push({ name, address: addr.address });
    }
  }
  return out;
}

const LINK_LOCAL_V6 = /^fe[89ab][0-9a-f]:/i;

/**
 * The interfaces mDNS should run on: every external IPv4 address (see {@link listIPv4Interfaces}), then one IPv6
 * link-local address per adapter (mDNS over IPv6 is per link, whatever global addresses the adapter has).
 */
export function listMdnsInterfaces(nets?: NodeJS.Dict<os.NetworkInterfaceInfo[]>): NetworkInterfaceInfo[] {
  const all = nets ?? os.networkInterfaces();
  const scopes = new Map<string, { address: string; scopeId: number }>();
  for (const [name, addrs] of Object.entries(all)) {
    for (const addr of addrs ?? []) {
      const family: unknown = addr.family;
      if (family !== "IPv6" && family !== 6) continue;
      if (addr.internal || !LINK_LOCAL_V6.test(addr.address)) continue;
      const scopeId = (addr as { scopeid?: number }).scopeid;
      if (typeof scopeId !== "number" || scopeId <= 0) continue;
      if (!scopes.has(name)) scopes.set(name, { address: addr.address.split("%")[0] ?? addr.address, scopeId });
    }
  }
  const v4 = listIPv4Interfaces(all).map((i): NetworkInterfaceInfo => {
    const scope = scopes.get(i.name);
    return scope ? { ...i, scopeId: scope.scopeId } : i;
  });
  const v6 = [...scopes].map(([name, { address, scopeId }]): NetworkInterfaceInfo => ({ name, address, family: "IPv6", scopeId }));
  return [...v4, ...v6];
}

/** Identifies an interface: IPv6 link-local addresses repeat across adapters, so they carry their scope. */
function ifaceKey(iface: NetworkInterfaceInfo): string {
  return iface.family === "IPv6" ? `${iface.address}%${iface.scopeId ?? iface.name}` : iface.address;
}

/** Options of {@link CastDiscovery}. Every field is optional; the comments name the defaults. */
export interface CastDiscoveryOptions {
  serviceName?: string;          // default "_googlecast._tcp.local"
  interfaces?: () => NetworkInterfaceInfo[];   // default () => listMdnsInterfaces() (IPv4, plus IPv6 link-local)
  openSocket?: OpenMdnsSocket;   // default openUdpMdnsSocket
  followUpQueriesMs?: number[];  // default [1000, 3000], measured from start
  refreshMs?: number;            // default 60000
  expireCheckMs?: number;        // default 1000
  interfaceCheckMs?: number;     // default 10000
  resumeGapMs?: number;          // default 3 x interfaceCheckMs: a check this late means the machine slept
}

/** The events a {@link CastDiscovery} emits. `socketError` is one interface failing; the others carry on. */
export interface CastDiscoveryEvents {
  deviceUp: [device: CastDevice];
  deviceDown: [device: CastDevice];
  deviceChanged: [device: CastDevice];
  socketError: [iface: NetworkInterfaceInfo, error: Error];
}

interface SocketEntry {
  iface: NetworkInterfaceInfo;
  socket: MdnsSocket;
}

/**
 * A link-local AAAA record (`fe80::...`) only names a device together with the link it was heard on, so the
 * interface's scope is appended (`fe80::1%12`); with no known scope the address is unusable and the record is
 * dropped. Everything else passes through.
 */
function scopeLinkLocal(record: DnsRecord, iface: NetworkInterfaceInfo): DnsRecord[] {
  if (record.type !== "AAAA" || !LINK_LOCAL_V6.test(record.data) || record.data.includes("%")) return [record];
  if (iface.scopeId === undefined) return [];
  return [{ ...record, data: `${record.data}%${iface.scopeId}` }];
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Discovers Cast devices by sending mDNS PTR queries on every external IPv4
 * interface (and over IPv6 link-local where it works) and joining the answers into {@link CastDevice}s.
 */
export class CastDiscovery extends EventEmitter<CastDiscoveryEvents> {
  private readonly serviceName: string;
  private readonly listIfaces: () => NetworkInterfaceInfo[];
  private readonly openSocketFn: OpenMdnsSocket;
  private readonly followUpQueriesMs: number[];
  private readonly refreshMs: number;
  private readonly expireCheckMs: number;
  private readonly interfaceCheckMs: number;
  private readonly resumeGapMs: number;
  private readonly queryPacket: Buffer;
  private cache: CastDeviceCache;
  private sockets: SocketEntry[] = [];
  private readonly pending = new Set<string>();
  /** Interfaces whose last open failed and was reported, so a retry loop does not repeat the report. */
  private readonly failed = new Set<string>();
  /** Interface keys of the last listing, to tell which interfaces went away. */
  private lastListed = new Set<string>();
  private lastCheckAt = 0;
  private timers: NodeJS.Timeout[] = [];
  private startPromise: Promise<void> | null = null;
  private stopped = false;

  constructor(options: CastDiscoveryOptions = {}) {
    super();
    this.serviceName = options.serviceName ?? DEFAULT_SERVICE_NAME;
    this.listIfaces = options.interfaces ?? (() => listMdnsInterfaces());
    this.openSocketFn = options.openSocket ?? openUdpMdnsSocket;
    this.followUpQueriesMs = options.followUpQueriesMs ?? [1000, 3000];
    this.refreshMs = options.refreshMs ?? 60_000;
    this.expireCheckMs = options.expireCheckMs ?? 1000;
    this.interfaceCheckMs = options.interfaceCheckMs ?? 10_000;
    this.resumeGapMs = options.resumeGapMs ?? this.interfaceCheckMs * 3;
    this.cache = new CastDeviceCache(this.serviceName);
    this.queryPacket = encodeMdnsQuery(this.serviceName, RecordType.PTR);
  }

  /** Opens a socket on every interface and starts querying; see the options for the schedule. */
  start(): Promise<void> {
    if (this.stopped) return Promise.reject(new Error("discovery stopped"));
    if (this.startPromise !== null) return this.startPromise;
    this.startTimers();
    const ifaces = this.listIfaces();
    this.lastListed = new Set(ifaces.map(ifaceKey));
    this.startPromise = Promise.allSettled(ifaces.map((iface) => this.openIface(iface))).then(
      () => undefined,
    );
    return this.startPromise;
  }

  /** Sends one query on every open socket now. */
  query(): void {
    if (this.stopped) return;
    for (const entry of [...this.sockets]) this.safeQuery(entry.iface, entry.socket);
  }

  /** Fresh copies of all currently known devices. */
  devices(): CastDevice[] {
    return this.cache.devices();
  }

  /** The interfaces with an open socket, in the order their sockets were added. */
  interfaces(): NetworkInterfaceInfo[] {
    return this.sockets.map((entry) => ({ ...entry.iface }));
  }

  /** Stops everything at once: timers, sockets, remembered devices. Idempotent. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const timer of this.timers) {
      clearTimeout(timer);
      clearInterval(timer);
    }
    this.timers = [];
    for (const entry of this.sockets) this.closeQuietly(entry.socket);
    this.sockets = [];
    this.pending.clear();
    this.failed.clear();
    this.cache = new CastDeviceCache(this.serviceName);
  }

  private startTimers(): void {
    for (const offset of this.followUpQueriesMs) {
      this.timers.push(setTimeout(() => this.query(), offset));
    }
    const lastFollowUp = this.followUpQueriesMs.length > 0 ? Math.max(...this.followUpQueriesMs) : 0;
    this.timers.push(
      setTimeout(() => {
        this.query();
        this.timers.push(setInterval(() => this.query(), this.refreshMs));
      }, lastFollowUp + this.refreshMs),
    );
    this.timers.push(
      setInterval(() => {
        const change = this.cache.expire(Date.now());
        for (const device of change.removed) this.emit("deviceDown", device);
      }, this.expireCheckMs),
    );
    this.lastCheckAt = Date.now();
    this.timers.push(setInterval(() => this.checkInterfaces(), this.interfaceCheckMs));
  }

  /** Opens a socket on `iface`; on success adds it and sends one query on it. */
  private openIface(iface: NetworkInterfaceInfo): Promise<void> {
    const key = ifaceKey(iface);
    this.pending.add(key);
    const work = (async (): Promise<void> => {
      // Errors are matched to this socket, not to its address: a late error from a replaced socket must not
      // close the socket that replaced it.
      const holder: { socket?: MdnsSocket } = {};
      let socket: MdnsSocket;
      try {
        socket = await this.openSocketFn(iface, this.makeHandlers(iface, holder));
      } catch (error) {
        if (!this.stopped && !this.failed.has(key)) {
          this.failed.add(key);
          this.emit("socketError", iface, toError(error));
        }
        return;
      }
      holder.socket = socket;
      this.failed.delete(key);
      if (this.stopped || this.sockets.some((s) => ifaceKey(s.iface) === key)) {
        this.closeQuietly(socket);
        return;
      }
      this.sockets.push({ iface, socket });
      this.safeQuery(iface, socket);
    })();
    return work.finally(() => this.pending.delete(key));
  }

  private makeHandlers(iface: NetworkInterfaceInfo, holder: { socket?: MdnsSocket }): MdnsSocketHandlers {
    return {
      message: (packet: Buffer) => this.onMessage(packet, iface),
      error: (error: Error) => this.onSocketError(iface, error, holder.socket),
    };
  }

  private onMessage(packet: Buffer, iface: NetworkInterfaceInfo): void {
    if (this.stopped) return;
    let decoded: DnsPacket;
    try {
      decoded = decodeDnsPacket(packet);
    } catch {
      return;
    }
    if (!decoded.isResponse) return;
    const records = [...decoded.answers, ...decoded.authorities, ...decoded.additionals].flatMap((r) =>
      scopeLinkLocal(r, iface),
    );
    this.emitChange(this.cache.ingest(records, Date.now(), ifaceKey(iface)));
  }

  private emitChange(change: CacheChange): void {
    for (const device of change.removed) this.emit("deviceDown", device);
    for (const device of change.updated) this.emit("deviceChanged", device);
    for (const device of change.added) this.emit("deviceUp", device);
  }

  private onSocketError(iface: NetworkInterfaceInfo, error: Error, socket: MdnsSocket | undefined): void {
    if (this.stopped) return;
    const idx = this.sockets.findIndex((s) => s.socket === socket);
    if (idx === -1) {
      // Not (or no longer) one of ours: a socket already dropped or replaced. Close it quietly.
      if (socket !== undefined) this.closeQuietly(socket);
      return;
    }
    this.sockets.splice(idx, 1);
    if (socket !== undefined) this.closeQuietly(socket);
    this.emit("socketError", iface, error);
  }

  private safeQuery(iface: NetworkInterfaceInfo, socket: MdnsSocket): void {
    try {
      socket.send(this.queryPacket);
    } catch (error) {
      this.onSocketError(iface, toError(error), socket);
    }
  }

  /** Re-lists interfaces: opens new ones, closes vanished ones, leaves the rest alone. */
  private checkInterfaces(): void {
    if (this.stopped) return;
    let ifaces: NetworkInterfaceInfo[];
    try {
      ifaces = this.listIfaces();
    } catch {
      return;
    }
    // A timer that fires long after it was due means the machine slept. Sockets can come back from sleep alive but
    // deaf (lost multicast membership, no error), so open fresh ones rather than trust them.
    const now = Date.now();
    const resumed = now - this.lastCheckAt > this.resumeGapMs;
    this.lastCheckAt = now;
    if (resumed) {
      for (const entry of this.sockets) this.closeQuietly(entry.socket);
      this.sockets = [];
    }
    const listed = new Set(ifaces.map(ifaceKey));
    this.sockets = this.sockets.filter((entry) => {
      if (listed.has(ifaceKey(entry.iface))) return true;
      this.closeQuietly(entry.socket);
      return false;
    });
    // Devices that were only heard on an interface that is gone cannot be reached, so they go now, not after their TTL.
    for (const key of this.lastListed) {
      if (listed.has(key)) continue;
      this.failed.delete(key);
      this.emitChange(this.cache.dropSource(key));
    }
    this.lastListed = listed;
    for (const iface of ifaces) {
      const key = ifaceKey(iface);
      if (this.sockets.some((s) => ifaceKey(s.iface) === key)) continue;
      if (this.pending.has(key)) continue;
      void this.openIface(iface);
    }
  }

  private closeQuietly(socket: MdnsSocket): void {
    try {
      socket.close();
    } catch {
      // already closed
    }
  }
}
