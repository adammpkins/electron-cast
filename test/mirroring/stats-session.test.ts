import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createEncodingSupport } from "../../src/mirroring/encoding-support.ts";
import { createMirroringServiceFactory } from "../../src/mirroring/engine.ts";
import type { MirroringClient } from "../../src/mirroring/mirroring-activity.ts";
import { MirroringManager } from "../../src/mirroring/mirroring-manager.ts";
import type { MirroringStats } from "../../src/mirroring/stats/statistics.ts";
import type { CastDevice } from "../../src/discovery/index.ts";
import { FakeBackend } from "./fake-backend.ts";
import { FakeReceiver } from "./fake-receiver.ts";
import { sleep, startHarness } from "./session-harness.ts";

/** The sender (session host, senders, router, UDP) against the fake receiver, which sends an RTCP event log. */

test("a session with RTCP reporting analyzes the receiver's event log into Chrome's statistics", async () => {
  // The receiver's log clock runs 1000 s ahead of the sender's, so the estimated offset has to be applied.
  const h = await startHarness({ enableRtcpReporting: true, receiver: { eventLog: true, eventLogClockOffsetMs: 1_000_000 } });
  try {
    await sleep(2600);
    const stats = h.host.getMirroringStats();
    const video = stats.video!;
    const audio = stats.audio!;
    console.log(
      `stats: video ${video.NUM_PACKETS_SENT} sent / ${video.NUM_PACKETS_RECEIVED} received, ${Number(video.ENQUEUE_FPS).toFixed(1)} fps, network ${video.AVG_NETWORK_LATENCY_MS} ms, e2e ${video.AVG_E2E_LATENCY_MS} ms`,
    );
    assert.deepEqual(h.errors, []);
    // Sender-side counters merged from the senders, as OpenscreenSessionHost::GetMirroringStats does.
    assert.ok((video.FRAMES_INSERTED as number) >= 50);
    assert.ok((video.TARGET_BITRATE as number) > 0);
    assert.equal(typeof video.ENCODER_UTILIZATION, "number");
    assert.ok((audio.FRAMES_INSERTED as number) >= 150);
    // Collected from the router and the senders.
    assert.ok((video.NUM_FRAMES_CAPTURED as number) >= 50);
    assert.ok((video.NUM_PACKETS_SENT as number) >= 50);
    assert.ok((video.NUM_PACKETS_SENT as number) < 2000);
    const fps = video.ENQUEUE_FPS as number;
    assert.ok(fps > 15 && fps < 35, `fps ${fps}`);
    assert.ok((audio.NUM_FRAMES_CAPTURED as number) >= 150);
    // From the receiver's log. The offset is estimated, so latencies are small numbers rather than ~1e6.
    assert.ok((video.NUM_PACKETS_RECEIVED as number) >= 40, `received ${video.NUM_PACKETS_RECEIVED}`);
    const network = video.AVG_NETWORK_LATENCY_MS as number;
    assert.ok(Number.isFinite(network) && Math.abs(network) < 100, `network latency ${network}`);
    const e2e = video.AVG_E2E_LATENCY_MS as number;
    assert.ok(e2e > -100 && e2e < 1000, `e2e ${e2e}`);
    const sinceResponse = video.MS_SINCE_LAST_RECEIVER_RESPONSE as number;
    assert.ok(sinceResponse >= 0 && sinceResponse < 1500, `since response ${sinceResponse}`);
    assert.ok(Array.isArray(video.NETWORK_LATENCY_MS_HISTO) && video.NETWORK_LATENCY_MS_HISTO.length > 0);
    assert.ok((video.FIRST_EVENT_TIME_MS as number) > 0);
    assert.ok((video.LAST_EVENT_TIME_MS as number) > (video.FIRST_EVENT_TIME_MS as number));
  } finally {
    h.close();
  }
});

test("without RTCP reporting only the senders' own counters are reported", async () => {
  const h = await startHarness({ receiver: { eventLog: true } });
  try {
    await sleep(800);
    const stats = h.host.getMirroringStats();
    assert.deepEqual(Object.keys(stats.video!).sort(), ["ENCODER_UTILIZATION", "FRAMES_DROPPED", "FRAMES_INSERTED", "LOSSINESS", "TARGET_BITRATE"]);
    assert.deepEqual(Object.keys(stats.audio!).sort(), ["FRAMES_DROPPED", "FRAMES_INSERTED"]);
  } finally {
    h.close();
  }
});

class FakeClient extends EventEmitter implements MirroringClient {
  readonly senderId = "sender-fake01";
  lastSource = "";
  receiver!: FakeReceiver;
  async connect(): Promise<void> {}
  close(): void {}
  send(namespace: string, _destinationId: string, payload: string): void {
    this.lastSource = this.senderId;
    setImmediate(() => this.receiver.onControlMessage(namespace, payload));
  }
  async launch(appId: string) {
    return { appId, displayName: "Fake Streaming", sessionId: "sess-1", transportId: "transport-1", namespaces: [] };
  }
  async stop() {
    return { applications: [], volume: {} };
  }
  connectTransport(): void {}
  closeTransport(): void {}
}

const device: CastDevice = { id: "dev-1", name: "Fake TV", model: "Fake", host: "127.0.0.1", addresses: ["127.0.0.1"], port: 8009, capabilities: 1 | 4, isGroup: false, statusText: "", instanceName: "fake", txt: {} };

async function startManager() {
  const receiver = await FakeReceiver.create({ eventLog: true });
  const client = new FakeClient();
  client.receiver = receiver;
  const manager = new MirroringManager({
    findDevice: (id) => (id === "dev-1" ? device : undefined),
    createClient: () => client,
    createService: createMirroringServiceFactory({
      createBackend: () => new FakeBackend(() => performance.now()),
      encodingSupport: createEncodingSupport({ hardware: new Set(), software: new Set(["vp8"]) }),
      env: {},
    }),
  });
  receiver.sendControl = (json) =>
    setImmediate(() => client.emit("message", { namespace: "urn:x-cast:com.google.cast.webrtc", sourceId: "transport-1", destinationId: client.lastSource, data: json }));
  return { receiver, manager };
}

test("the manager fetches statistics every 500 ms for sessions started while enabled, and tells observers", async () => {
  const { receiver, manager } = await startManager();
  try {
    assert.equal(manager.isMirroringStatsEnabled(), false);
    const seen: { routeId: string; stats: MirroringStats }[] = [];
    const off = manager.observeMirroringStats((routeId, stats) => seen.push({ routeId, stats }));

    // Off by default: no statistics are fetched for a session that starts now.
    const quiet = await manager.startMirroring("dev-1", { castMode: "tab_mirror", webContentsId: 1 });
    await sleep(1200);
    assert.deepEqual(manager.getMirroringStats(quiet.id), {});
    assert.equal(seen.length, 0);
    manager.terminate(quiet.id);
    await sleep(100);

    manager.setMirroringStatsEnabled(true);
    assert.equal(manager.isMirroringStatsEnabled(), true);
    const route = await manager.startMirroring("dev-1", { castMode: "tab_mirror", webContentsId: 2 });
    await sleep(2300);
    // Roughly 4 fetches in 2.3 s; the first one waits 500 ms after the session started.
    assert.ok(seen.length >= 2 && seen.length <= 5, `observed ${seen.length} updates`);
    assert.ok(seen.every((s) => s.routeId === route.id));
    const stats = manager.getMirroringStats(route.id);
    assert.ok(stats.video !== undefined && (stats.video.NUM_PACKETS_SENT as number) > 0);
    assert.ok((stats.video!.FRAMES_INSERTED as number) > 0);
    // A copy: changing it does not change what the manager keeps.
    (stats.video as Record<string, unknown>).NUM_PACKETS_SENT = -1;
    assert.notEqual((manager.getMirroringStats(route.id).video as Record<string, unknown>).NUM_PACKETS_SENT, -1);

    off();
    const count = seen.length;
    manager.terminate(route.id);
    await sleep(1200);
    assert.equal(seen.length, count);
    assert.deepEqual(manager.getMirroringStats(route.id), {});
  } finally {
    manager.dispose();
    receiver.close();
  }
});
