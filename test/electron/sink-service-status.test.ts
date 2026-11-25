import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { DiscoveredSinksTracker, MediaSinkServiceStatus, sinkToStatusValue } from "../../src/electron/sink-service-status.ts";
import { toMediaSink } from "../../src/electron/manager-api.ts";
import { MediaRouterLogger } from "../../src/electron/logger.ts";
import { createCastManager, type IpcMainLike } from "../../src/electron/main.ts";
import { FakeDevices, FakeClient, TV, SPEAKER, device, FAST_SINKS, tick } from "./fakes.ts";

const CAST_SINK = toMediaSink(device({ id: "0123456789abcdef", name: "Lounge", model: "Chromecast", capabilities: 5 }));
const DIAL_SINK = toMediaSink(device({
  id: "dial:uuid-1", name: "TV", capabilities: 0, port: 0,
  dial: { appUrl: "http://10.0.0.5:8008/apps/", modelName: "Smart TV", ipAddress: "10.0.0.5" },
}));

test("sinkToStatusValue: the fields of ToValue(MediaSinkInternal), the id cut to 9 characters", () => {
  assert.deepEqual(sinkToStatusValue(CAST_SINK, true), {
    capabilities: 5, channel_id: 0, discovered_by_dial: true, icon_type: 0, id: "012345678",
    ip_endpoint: "10.0.0.10:8009", model_name: "Chromecast", name: "Lounge",
  });
  assert.deepEqual(sinkToStatusValue(DIAL_SINK, false), {
    app_url: "http://10.0.0.5:8008/apps/", icon_type: 7, id: "dial:uuid", ip_address: "10.0.0.5", model_name: "Smart TV", name: "TV",
  });
  const v6 = toMediaSink(device({ addresses: ["fe80::1"], host: "fe80::1" }));
  assert.equal(sinkToStatusValue(v6, false).ip_endpoint, "[fe80::1]:8009");
  assert.equal(sinkToStatusValue(toMediaSink(device({ capabilities: 4 })), false).icon_type, 2);
  assert.equal(sinkToStatusValue(toMediaSink(device({ capabilities: 36 })), false).icon_type, 1);
});

test("MediaSinkServiceStatus: keys are sorted and the JSON is the value, pretty printed", () => {
  const s = new MediaSinkServiceStatus();
  assert.deepEqual(s.getStatusAsValue(), { available_sinks: {}, discovered_sinks: {} });
  s.updateDiscoveredSinks("dial", [{ sink: DIAL_SINK, discoveredByDial: false }]);
  s.updateDiscoveredSinks("cast", [{ sink: CAST_SINK, discoveredByDial: false }]);
  s.updateAvailableSinks("DIAL", "cast-dial:YouTube", []);
  s.updateAvailableSinks("CAST", "cast:CC1AD845", ["0123456789abcdef", "b"]);
  const v = s.getStatusAsValue();
  assert.deepEqual(Object.keys(v), ["available_sinks", "discovered_sinks"]);
  assert.deepEqual(Object.keys(v.discovered_sinks), ["cast", "dial"]);
  assert.deepEqual(Object.keys(v.available_sinks), ["CAST:cast:CC1AD845", "DIAL:cast-dial:YouTube"]);
  assert.deepEqual(v.available_sinks["CAST:cast:CC1AD845"], ["012345678", "b"]);
  assert.deepEqual(JSON.parse(s.getStatusAsJSONString()), v);
  assert.ok(s.getStatusAsJSONString().includes("\n   "));
  // the value is a copy
  v.available_sinks["CAST:cast:CC1AD845"]!.push("x");
  assert.equal(s.getStatusAsValue().available_sinks["CAST:cast:CC1AD845"]!.length, 2);
});

test("MediaSinkServiceStatus: only the last 100 sources are kept, and an update makes a source the newest", () => {
  const s = new MediaSinkServiceStatus();
  for (let i = 0; i < 100; i++) s.updateAvailableSinks("CAST", `src${i}`, []);
  s.updateAvailableSinks("CAST", "src0", ["a"]);
  s.updateAvailableSinks("CAST", "extra", []);
  const keys = Object.keys(s.getStatusAsValue().available_sinks);
  assert.equal(keys.length, 100);
  assert.ok(keys.includes("CAST:src0"), "refreshed, so not the oldest");
  assert.ok(!keys.includes("CAST:src1"), "the least recently updated went");
  assert.ok(keys.includes("CAST:extra"));
});

test("DiscoveredSinksTracker: a change is reported 3 s later, once, and only when the list differs", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const s = new MediaSinkServiceStatus();
    const events = new EventEmitter();
    let sinks = [{ sink: CAST_SINK, discoveredByDial: false }];
    const t = new DiscoveredSinksTracker(s, "cast", () => sinks, (l) => {
      events.on("change", l);
      return () => events.off("change", l);
    });
    events.emit("change");
    events.emit("change");
    mock.timers.tick(2999);
    assert.deepEqual(s.getStatusAsValue().discovered_sinks, {}, "nothing before the timeout");
    mock.timers.tick(1);
    assert.equal(s.getStatusAsValue().discovered_sinks["cast"]!.length, 1);
    // a change that leaves the list as it was is not reported again
    const before = JSON.stringify(s.getStatusAsValue());
    events.emit("change");
    mock.timers.tick(3000);
    assert.equal(JSON.stringify(s.getStatusAsValue()), before);
    sinks = [];
    events.emit("change");
    mock.timers.tick(3000);
    assert.deepEqual(s.getStatusAsValue().discovered_sinks["cast"], [], "the service now reports none");
    t.dispose();
    sinks = [{ sink: CAST_SINK, discoveredByDial: false }];
    events.emit("change");
    mock.timers.tick(3000);
    assert.deepEqual(s.getStatusAsValue().discovered_sinks["cast"], []);
  } finally {
    mock.timers.reset();
  }
});

test("MediaRouterLogger.getLogsAsJson: keys in the order of a sorted dictionary", () => {
  const l = new MediaRouterLogger();
  l.info("Discovery", "C", "m", { sinkId: "sink", mediaSource: "src", sessionId: "sess" });
  const parsed = JSON.parse(l.getLogsAsJson()) as Record<string, string>[];
  assert.deepEqual(Object.keys(parsed[0]!), ["category", "component", "mediaSource", "message", "sessionId", "severity", "sinkId", "time"]);
  assert.equal(new MediaRouterLogger().getLogsAsJson(), "[]");
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
class Discovery extends FakeDevices {
  async start(): Promise<void> {}
  stop(): void {}
}

function manager(commandLine?: { hasSwitch(n: string): boolean; getSwitchValue(n: string): string }) {
  return createCastManager({
    sinks: FAST_SINKS,
    ipcMain: new Ipc(),
    discovery: new Discovery([TV, SPEAKER]),
    ...(commandLine === undefined ? {} : { commandLine }),
    createClient: (d: never) => {
      const c = new FakeClient(d);
      c.echoReplies = true;
      return c;
    },
    selectDevice: async () => null,
  } as never);
}

test("the manager API: the sink service status records each observed source, and GetLogsAsString is the log as JSON", async () => {
  const m = manager();
  await m.start();
  await m.settled();
  assert.deepEqual(m.getMediaSinkServiceStatus().available_sinks, {}, "an observer with no source is not a Chrome source");
  const stopAll = m.registerMediaSinksObserver({ onSinksUpdated: () => {} });
  const stopTab = m.registerMediaSinksObserver({ onSinksUpdated: () => {} }, { castMode: "tab_mirror" });
  const stopDesktop = m.registerMediaSinksObserver({ onSinksUpdated: () => {} }, { castMode: "desktop_mirror", withAudio: false });
  const available = m.getMediaSinkServiceStatus().available_sinks;
  const keys = Object.keys(available);
  assert.equal(keys.length, 2);
  assert.ok(keys.every((k) => k.startsWith("CAST:")));
  const tabKey = keys.find((k) => k.includes("tab"))!;
  assert.equal(available[tabKey]!.length, 2, "both devices play audio, so both can take tab mirroring");
  const desktopKey = keys.find((k) => k.includes("desktop"))!;
  assert.deepEqual(available[desktopKey], [TV.id.slice(0, 9)], "a screen without audio needs video_out");
  assert.deepEqual(JSON.parse(m.getMediaSinkServiceStatusAsString()), m.getMediaSinkServiceStatus());
  assert.ok(Array.isArray(JSON.parse(m.getLogsAsString())));
  assert.equal(JSON.parse(m.getLogsAsString()).length, m.getLogs().length);
  stopAll();
  stopTab();
  stopDesktop();
  m.dispose();
  await tick();
});

test("the manager API: with the media router off the status is empty", async () => {
  const m = manager({ hasSwitch: (n) => n === "disable-features", getSwitchValue: () => "MediaRouter" });
  await m.start();
  assert.deepEqual(m.getMediaSinkServiceStatus(), { available_sinks: {}, discovered_sinks: {} });
  m.dispose();
  await tick();
});
