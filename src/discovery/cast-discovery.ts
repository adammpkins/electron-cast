import { EventEmitter } from "node:events";
import os from "node:os";
import { CastDeviceCache, type CastDevice } from "./device-cache.ts";
import { decodeDnsPacket, encodeMdnsQuery, RecordType, type DnsPacket } from "./dns-packet.ts";
import { openUdpMdnsSocket } from "./udp-socket.ts";

/** An external IPv4 interface. */
export interface NetworkInterfaceInfo { name: string; address: string }

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

export interface CastDiscoveryOptions {
  serviceName?: string;          // default "_googlecast._tcp.local"
  interfaces?: () => NetworkInterfaceInfo[];   // default () => listIPv4Interfaces()
  openSocket?: OpenMdnsSocket;   // default openUdpMdnsSocket
  followUpQueriesMs?: number[];  // default [1000, 3000], measured from start
  refreshMs?: number;            // default 60000
  expireCheckMs?: number;        // default 1000
  interfaceCheckMs?: number;     // default 10000
}

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

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Discovers Cast devices by sending mDNS PTR queries on every external IPv4
 * interface and joining the answers into {@link CastDevice}s.
 */
export class CastDiscovery extends EventEmitter<CastDiscoveryEvents> {
  private readonly serviceName: string;
  private readonly listIfaces: () => NetworkInterfaceInfo[];
  private readonly openSocketFn: OpenMdnsSocket;
  private readonly followUpQueriesMs: number[];
  private readonly refreshMs: number;
  private readonly expireCheckMs: number;
  private readonly interfaceCheckMs: number;
  private readonly queryPacket: Buffer;
  private cache: CastDeviceCache;
  private sockets: SocketEntry[] = [];
  private readonly pending = new Set<string>();
  private timers: NodeJS.Timeout[] = [];
  private startPromise: Promise<void> | null = null;
  private stopped = false;

  constructor(options: CastDiscoveryOptions = {}) {
    super();
    this.serviceName = options.serviceName ?? DEFAULT_SERVICE_NAME;
    this.listIfaces = options.interfaces ?? (() => listIPv4Interfaces());
    this.openSocketFn = options.openSocket ?? openUdpMdnsSocket;
    this.followUpQueriesMs = options.followUpQueriesMs ?? [1000, 3000];
    this.refreshMs = options.refreshMs ?? 60_000;
    this.expireCheckMs = options.expireCheckMs ?? 1000;
    this.interfaceCheckMs = options.interfaceCheckMs ?? 10_000;
    this.cache = new CastDeviceCache(this.serviceName);
    this.queryPacket = encodeMdnsQuery(this.serviceName, RecordType.PTR);
  }

  /** Opens a socket on every interface and starts querying; see the options for the schedule. */
  start(): Promise<void> {
    if (this.stopped) return Promise.reject(new Error("discovery stopped"));
    if (this.startPromise !== null) return this.startPromise;
    this.startTimers();
    const ifaces = this.listIfaces();
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
    this.timers.push(setInterval(() => this.checkInterfaces(), this.interfaceCheckMs));
  }

  /** Opens a socket on `iface`; on success adds it and sends one query on it. */
  private openIface(iface: NetworkInterfaceInfo): Promise<void> {
    this.pending.add(iface.address);
    const work = (async (): Promise<void> => {
      // Errors are matched to this socket, not to its address: a late error from a replaced socket must not
      // close the socket that replaced it.
      const holder: { socket?: MdnsSocket } = {};
      let socket: MdnsSocket;
      try {
        socket = await this.openSocketFn(iface, this.makeHandlers(iface, holder));
      } catch (error) {
        if (!this.stopped) this.emit("socketError", iface, toError(error));
        return;
      }
      holder.socket = socket;
      if (this.stopped || this.sockets.some((s) => s.iface.address === iface.address)) {
        this.closeQuietly(socket);
        return;
      }
      this.sockets.push({ iface, socket });
      this.safeQuery(iface, socket);
    })();
    return work.finally(() => this.pending.delete(iface.address));
  }

  private makeHandlers(iface: NetworkInterfaceInfo, holder: { socket?: MdnsSocket }): MdnsSocketHandlers {
    return {
      message: (packet: Buffer) => this.onMessage(packet),
      error: (error: Error) => this.onSocketError(iface, error, holder.socket),
    };
  }

  private onMessage(packet: Buffer): void {
    if (this.stopped) return;
    let decoded: DnsPacket;
    try {
      decoded = decodeDnsPacket(packet);
    } catch {
      return;
    }
    if (!decoded.isResponse) return;
    const records = [...decoded.answers, ...decoded.authorities, ...decoded.additionals];
    const change = this.cache.ingest(records, Date.now());
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
    const listed = new Set(ifaces.map((i) => i.address));
    this.sockets = this.sockets.filter((entry) => {
      if (listed.has(entry.iface.address)) return true;
      this.closeQuietly(entry.socket);
      return false;
    });
    for (const iface of ifaces) {
      if (this.sockets.some((s) => s.iface.address === iface.address)) continue;
      if (this.pending.has(iface.address)) continue;
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
