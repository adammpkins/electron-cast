import { createHash } from "node:crypto";
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";

/** `DiscoveryNetworkMonitor::kNetworkIdDisconnected`: no interface is connected. */
export const NETWORK_ID_DISCONNECTED = "__disconnected__";
/** `DiscoveryNetworkMonitor::kNetworkIdUnknown`: interfaces are up but none could be told apart. */
export const NETWORK_ID_UNKNOWN = "__unknown__";

/**
 * How often the interfaces are read. Chrome is told of a change by `NetworkChangeNotifier`; Node has no such event, so
 * the list is read again on this interval (docs/DESIGN.md, "Network changes").
 */
export const NETWORK_POLL_MS = 5000;

/** `DiscoveryNetworkInfo`: one connected interface and what tells its network apart. */
export interface DiscoveryNetworkInfo {
  name: string;
  networkId: string;
}

/**
 * Tells observers when the set of networks the machine is on changes (Chrome: `DiscoveryNetworkMonitor`). The manager
 * starts one, unless `networkMonitor: false`; pass your own to drive network changes in tests.
 */
export interface NetworkMonitor {
  /** The current network id (`GetNetworkId`): a hash of the connected networks, or one of the two fixed ids. */
  networkId(): string;
  /** Call `listener` with the new id each time it changes (`Observer::OnNetworksChanged`); returns the unsubscribe. */
  observe(listener: (networkId: string) => void): () => void;
  start(): void;
  stop(): void;
}

export const isNetworkIdUnknownOrDisconnected = (networkId: string): boolean =>
  networkId === NETWORK_ID_UNKNOWN || networkId === NETWORK_ID_DISCONNECTED;

/** `ComputeNetworkId`: SHA-256 over `"!" + id` of each network, in the list's order. */
export function computeNetworkId(list: readonly DiscoveryNetworkInfo[]): string {
  if (list.length === 0) return NETWORK_ID_DISCONNECTED;
  if (list.every((info) => info.networkId === "")) return NETWORK_ID_UNKNOWN;
  const hash = createHash("sha256");
  for (const info of list) hash.update("!").update(info.networkId);
  return hash.digest("hex");
}

const ipv4Network = (address: string, netmask: string): string | null => {
  const a = address.split(".").map(Number);
  const m = netmask.split(".").map(Number);
  if (a.length !== 4 || m.length !== 4 || [...a, ...m].some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  const prefix = m.reduce((bits, byte) => bits + byte.toString(2).replaceAll("0", "").length, 0);
  return `${a.map((byte, i) => byte & m[i]!).join(".")}/${prefix}`;
};

/**
 * `GetDiscoveryNetworkInfoList` from `os.networkInterfaces()`. Chrome takes the Ethernet and Wi-Fi interfaces that are
 * up, and identifies each by its Wi-Fi SSID or else its MAC address; Node reports neither the interface type nor the
 * SSID, so an interface counts when it is not loopback and has a MAC address (a tunnel has none), and its id is the MAC
 * with the IPv4 networks it is on, which changes when a Wi-Fi adapter joins another network. Sorted by id, as
 * `StableSortDiscoveryNetworkInfo` does.
 */
export function discoveryNetworkInfoList(
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(),
): DiscoveryNetworkInfo[] {
  const list: DiscoveryNetworkInfo[] = [];
  for (const [name, addresses] of Object.entries(interfaces)) {
    if (name === "" || addresses === undefined || addresses.length === 0 || addresses.some((a) => a.internal)) continue;
    const mac = addresses.find((a) => a.mac !== "" && a.mac !== "00:00:00:00:00:00")?.mac;
    if (mac === undefined) continue;
    const networks = new Set<string>();
    for (const a of addresses) {
      if (a.family !== "IPv4" && (a.family as unknown) !== 4) continue;
      const network = ipv4Network(a.address, a.netmask);
      if (network !== null) networks.add(network);
    }
    const id = mac.replaceAll(":", "").toUpperCase();
    list.push({ name, networkId: networks.size === 0 ? id : `${id}/${[...networks].sort().join(",")}` });
  }
  return list.sort((x, y) => (x.networkId < y.networkId ? -1 : x.networkId > y.networkId ? 1 : 0));
}

/** The {@link NetworkMonitor} the manager uses: reads the interfaces every {@link NETWORK_POLL_MS}. */
export class DiscoveryNetworkMonitor implements NetworkMonitor {
  private current: string | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly listeners = new Set<(networkId: string) => void>();
  private readonly list: () => DiscoveryNetworkInfo[];
  private readonly pollMs: number;

  constructor(options: { list?: () => DiscoveryNetworkInfo[]; pollMs?: number } = {}) {
    this.list = options.list ?? (() => discoveryNetworkInfoList());
    this.pollMs = options.pollMs ?? NETWORK_POLL_MS;
  }

  networkId(): string {
    this.current ??= this.compute();
    return this.current;
  }

  observe(listener: (networkId: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Takes the current id without telling anyone: Chrome's monitor is one per browser and has its id long before a
   * profile's services observe it. Changes from then on are told.
   */
  start(): void {
    if (this.timer !== undefined) return;
    this.networkId();
    this.timer = setInterval(() => this.update(), this.pollMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** `UpdateNetworkInfo`: observers hear of the new id only when it differs from the last. */
  update(): string {
    const next = this.compute();
    if (next !== this.current) {
      this.current = next;
      for (const listener of [...this.listeners]) listener(next);
    }
    return next;
  }

  private compute(): string {
    let list: DiscoveryNetworkInfo[];
    try {
      list = this.list();
    } catch {
      // `getifaddrs` failing gives Chrome an empty list
      list = [];
    }
    return computeNetworkId(list);
  }
}
