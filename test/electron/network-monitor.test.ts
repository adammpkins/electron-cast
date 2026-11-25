// Network changes follow Chrome's DiscoveryNetworkMonitor (discovery_network_monitor.cc) and its two observers,
// CastMediaSinkServiceImpl::OnNetworksChanged and AccessCodeCastSinkService::OnNetworksChanged. The monitor here is a
// fake, or the real one over a fake interface list; nothing reads the machine's network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { NetworkInterfaceInfo } from "node:os";
import {
  computeNetworkId, discoveryNetworkInfoList, DiscoveryNetworkMonitor, NETWORK_ID_DISCONNECTED, NETWORK_ID_UNKNOWN,
  type DiscoveryNetworkInfo, type NetworkMonitor,
} from "../../src/electron/network-monitor.ts";
import { CastSinkService } from "../../src/electron/sink-service.ts";
import { CastSessionService } from "../../src/electron/session-service.ts";
import { createCastManager, type IpcMainLike } from "../../src/electron/main.ts";
import { FakeClient, FakeClock, FakeDevices, FAST_SINKS, device, tick } from "./fakes.ts";

class FakeMonitor implements NetworkMonitor {
  id = "network-a";
  started = 0;
  stopped = 0;
  readonly listeners = new Set<(id: string) => void>();
  networkId(): string {
    return this.id;
  }
  observe(listener: (id: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  start(): void {
    this.started++;
  }
  stop(): void {
    this.stopped++;
  }
  change(id: string): void {
    this.id = id;
    for (const l of [...this.listeners]) l(id);
  }
}

const nic = (over: Partial<NetworkInterfaceInfo>): NetworkInterfaceInfo =>
  ({ address: "192.168.1.20", netmask: "255.255.255.0", family: "IPv4", mac: "aa:bb:cc:dd:ee:01", internal: false, cidr: "192.168.1.20/24", ...over }) as NetworkInterfaceInfo;

test("the network id is Chrome's: disconnected for no network, unknown when none has an id, else SHA-256 of !id per network", () => {
  assert.equal(computeNetworkId([]), NETWORK_ID_DISCONNECTED);
  assert.equal(computeNetworkId([{ name: "eth0", networkId: "" }]), NETWORK_ID_UNKNOWN);
  const list: DiscoveryNetworkInfo[] = [{ name: "eth0", networkId: "A" }, { name: "wlan0", networkId: "B" }];
  assert.equal(computeNetworkId(list), createHash("sha256").update("!A!B").digest("hex"));
});

test("the network list keeps interfaces that are not loopback and have a MAC, identified by MAC and IPv4 network, sorted by id", () => {
  const list = discoveryNetworkInfoList({
    lo: [nic({ address: "127.0.0.1", netmask: "255.0.0.0", mac: "00:00:00:00:00:00", internal: true })],
    "Wi-Fi": [nic({ mac: "bb:00:00:00:00:02", address: "10.0.5.7", netmask: "255.255.0.0" }), nic({ family: "IPv6", address: "fe80::1", netmask: "ffff:ffff:ffff:ffff::", mac: "bb:00:00:00:00:02" })],
    Ethernet: [nic({})],
    tun0: [nic({ address: "10.8.0.2", mac: "00:00:00:00:00:00" })],
  });
  assert.deepEqual(list, [
    { name: "Ethernet", networkId: "AABBCCDDEE01/192.168.1.0/24" },
    { name: "Wi-Fi", networkId: "BB0000000002/10.0.0.0/16" },
  ]);
  // another address on the same network is the same network; another network is not
  const sameNet = discoveryNetworkInfoList({ Ethernet: [nic({ address: "192.168.1.99" })] });
  const otherNet = discoveryNetworkInfoList({ Ethernet: [nic({ address: "192.168.7.20" })] });
  assert.deepEqual(sameNet, [list[0]]);
  assert.notDeepEqual(otherNet, [list[0]]);
});

test("the monitor takes its first id quietly, tells observers only of a different id, and stops polling", async () => {
  let current: DiscoveryNetworkInfo[] = [{ name: "eth0", networkId: "A" }];
  let reads = 0;
  const monitor = new DiscoveryNetworkMonitor({ list: () => (reads++, current), pollMs: 5 });
  const seen: string[] = [];
  monitor.observe((id) => seen.push(id));
  monitor.start();
  const first = monitor.networkId();
  assert.equal(first, computeNetworkId(current));
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(seen, [], "the same id is no change");
  current = [{ name: "eth0", networkId: "B" }];
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(seen, [computeNetworkId(current)]);
  monitor.stop();
  const after = reads;
  current = [];
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(reads, after, "no reads once stopped");
  assert.equal(monitor.update(), NETWORK_ID_DISCONNECTED);
  assert.deepEqual(seen.at(-1), NETWORK_ID_DISCONNECTED);
  const failing = new DiscoveryNetworkMonitor({ list: () => { throw new Error("uv_interface_addresses"); } });
  assert.equal(failing.networkId(), NETWORK_ID_DISCONNECTED, "a failed read is an empty list, as a failed getifaddrs");
});

function timed(body: (clock: FakeClock) => Promise<void>): () => Promise<void> {
  return async () => {
    const clock = new FakeClock().install();
    try {
      await body(clock);
    } finally {
      clock.restore();
    }
  };
}

test("leaving a network keeps the sinks; coming back to it reopens its sinks without mDNS, but not the access-code ones", timed(async (clock) => {
  const TV = device({ id: "dev-tv", host: "192.168.1.10", addresses: ["192.168.1.10"] });
  const WALL = device({ id: "<wall>", host: "192.168.1.30", addresses: ["192.168.1.30"] });
  const source = new FakeDevices([TV]);
  const opened: string[] = [];
  const service = new CastSinkService({
    source, openDelayMaxMs: 100, reportDelayMs: 0, random: () => 0.5,
    retry: { initialDelayMs: 10, jitter: 0, maxAttempts: 1, multiplyFactor: 1 },
    createClient: (d) => (opened.push(d.id), new FakeClient(d)),
  });
  service.onNetworksChanged("network-a");
  await clock.advance(100);
  assert.equal(await service.openSink(WALL), true);
  assert.deepEqual(service.sinks().map((d) => d.id).sort(), ["<wall>", "dev-tv"]);

  service.onNetworksChanged("network-b");
  await clock.advance(100);
  assert.deepEqual(service.sinks().map((d) => d.id).sort(), ["<wall>", "dev-tv"], "Chrome does not clear the sinks");
  // the devices are gone on the new network, and mDNS has not seen the TV again
  service.disconnectAndRemoveSink("dev-tv");
  service.disconnectAndRemoveSink("<wall>");
  source.list = [];
  opened.length = 0;

  service.onNetworksChanged(NETWORK_ID_DISCONNECTED);
  service.onNetworksChanged("network-c");
  await clock.advance(100);
  assert.deepEqual(opened, [], "a network not seen before has nothing cached");

  service.onNetworksChanged("network-a");
  await clock.advance(49);
  assert.deepEqual(opened, [], "after the random delay (OpenChannelsWithRandomizedDelay)");
  await clock.advance(1);
  assert.deepEqual(opened, ["dev-tv"]);
  assert.deepEqual(service.sinks().map((d) => d.id), ["dev-tv"]);
  service.dispose();
}));

test("the session service passes network changes to the sinks and to the devices added by address, and stops on dispose", async () => {
  const monitor = new FakeMonitor();
  const service = new CastSessionService({
    devices: new FakeDevices([]),
    sinks: FAST_SINKS,
    accessCode: { enabled: true, deviceDuration: 3600 },
    networkMonitor: monitor,
    createClient: (d) => new FakeClient(d),
    selectDevice: async () => null,
    emit: () => {},
  });
  try {
    assert.equal((service as unknown as { sinkService: { networkId: string } }).sinkService.networkId, "network-a", "the current id first, as Start asks GetNetworkId");
    const added = await service.addSinkByAddress({ id: "a1b2c3d4e5f60718293a4b5c6d7e8f90", name: "Seminar Room 4", capabilities: { videoOut: true, audioOut: true }, ipV4Address: "10.20.30.40" });
    assert.equal(added.code, "ok");
    await tick(5);
    assert.equal(service.devices().length, 1);
    monitor.change("network-b");
    // removed after kExpirationDelay (0.45 s), as Chrome's RemoveAndDisconnectMediaSinkFromRouter does
    await new Promise((r) => setTimeout(r, 500));
    assert.deepEqual(service.devices(), [], "a device added by address and not in use leaves (RemoveAndDisconnectExistingSinksOnNetwork)");
    assert.equal((service as unknown as { sinkService: { networkId: string } }).sinkService.networkId, "network-b");
  } finally {
    await service.dispose();
  }
  assert.equal(monitor.listeners.size, 0);
});

class Ipc implements IpcMainLike {
  handle(): void {}
  removeHandler(): void {}
  on(): unknown {
    return this;
  }
  removeListener(): unknown {
    return this;
  }
}

test("the manager starts and stops its monitor, and has no method for the app to report a network change", async () => {
  const monitor = new FakeMonitor();
  const manager = createCastManager({
    ipcMain: new Ipc(),
    discovery: Object.assign(new FakeDevices([]), { async start() {}, stop() {} }),
    sinks: FAST_SINKS,
    createClient: (d) => new FakeClient(d),
    selectDevice: async () => null,
    presentation: false,
    networkMonitor: monitor,
  });
  assert.equal(monitor.listeners.size, 1);
  await manager.start();
  assert.equal(monitor.started, 1);
  assert.equal("networkChanged" in manager, false);
  assert.equal("networksChanged" in manager, false);
  await manager.dispose();
  assert.equal(monitor.stopped, 1);
  assert.equal(monitor.listeners.size, 0);
});

test("the manager passes network changes to DIAL discovery, and starts it only when a network is up", async () => {
  const monitor = new FakeMonitor();
  monitor.id = NETWORK_ID_DISCONNECTED;
  let looked = 0;
  const manager = createCastManager({
    ipcMain: new Ipc(),
    discovery: Object.assign(new FakeDevices([]), { async start() {}, stop() {} }),
    sinks: FAST_SINKS,
    createClient: (d) => new FakeClient(d),
    selectDevice: async () => null,
    presentation: false,
    networkMonitor: monitor,
    dial: { registry: { interfaces: () => { looked++; return []; }, refreshMs: 3_600_000 } },
  });
  assert.equal(monitor.listeners.size, 2, "the sink services and DIAL discovery");
  await manager.start();
  assert.equal(looked, 0, "no search without a network");
  monitor.change("network-a");
  assert.equal(looked, 1, "a network came up: DIAL searches at once");
  monitor.change("network-b");
  assert.equal(looked, 2, "another network: forgotten and searched again");
  monitor.change(NETWORK_ID_DISCONNECTED);
  monitor.change("network-b");
  assert.equal(looked, 3);
  await manager.dispose();
  assert.equal(monitor.listeners.size, 0);
});
