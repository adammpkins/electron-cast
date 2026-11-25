import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IssueManager, RouterIssues, classifyLaunchFailure, originNameForDisplay, type Issue } from "../../src/electron/issues.ts";
import { MediaRouterLogger } from "../../src/electron/logger.ts";
import {
  castAllowAllIpsFeature, castDesktopMirroringKeepLocalAudio, castMirroringPlayoutDelayMs, developerCertificates, featureEnabled,
  fixedCastDevices, mediaRouterFeatureEnabled, showCastPermissionRejectedError, type CommandLineLike,
} from "../../src/electron/switches.ts";
import { CastTimeoutError, CastRequestError } from "../../src/client/index.ts";
import { createCastManager, type IpcMainLike } from "../../src/electron/main.ts";
import { FakeDevices, FakeClient, TV, FAST_SINKS, tick } from "./fakes.ts";

function line(args: Record<string, string>): CommandLineLike {
  return { hasSwitch: (n) => n in args, getSwitchValue: (n) => args[n] ?? "" };
}

test("IssueManager: an equal issue is not added twice, and the top issue is the oldest", () => {
  const m = new IssueManager();
  const tops: (string | null)[] = [];
  m.registerObserver({ onIssue: (i) => tops.push(i.info.title), onIssuesCleared: () => tops.push(null) });
  m.addIssue({ title: "a", severity: "warning", sinkId: "s1" });
  m.addIssue({ title: "a", severity: "warning", sinkId: "s1" });
  m.addIssue({ title: "b", severity: "warning", sinkId: "s2" });
  assert.deepEqual(tops, ["a"]);
  assert.equal(m.issuesNow().length, 2);
  const [a] = m.issuesNow();
  m.clearIssue(a!.id);
  assert.deepEqual(tops, ["a", "b"]);
  m.clearAllIssues();
  assert.deepEqual(tops, ["a", "b", null]);
  m.clearAllIssues();
  assert.equal(tops.length, 3, "nothing to tell");
  m.dispose();
});

test("IssueManager: a new observer is told of the top issue, and an unregistered one is not", () => {
  const m = new IssueManager();
  m.addIssue({ title: "x", severity: "notification", sinkId: "s" });
  const seen: string[] = [];
  const stop = m.registerObserver({ onIssue: (i) => seen.push(i.info.title) });
  assert.deepEqual(seen, ["x"]);
  stop();
  m.addIssue({ title: "y", severity: "notification", sinkId: "s" });
  m.clearAllIssues();
  assert.deepEqual(seen, ["x"]);
  m.dispose();
});

test("IssueManager: issues go after 60 s (notification) or 300 s (warning)", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const m = new IssueManager();
    m.addIssue({ title: "n", severity: "notification" });
    m.addIssue({ title: "w", severity: "warning" });
    mock.timers.tick(59_999);
    assert.equal(m.issuesNow().length, 2);
    mock.timers.tick(1);
    assert.deepEqual(m.issuesNow().map((i) => i.info.title), ["w"]);
    mock.timers.tick(239_999);
    assert.equal(m.issuesNow().length, 1);
    mock.timers.tick(1);
    assert.equal(m.issuesNow().length, 0);
    m.dispose();
  } finally {
    mock.timers.reset();
  }
});

test("IssueManager: clearTopIssueForSink only clears the top issue, and only for its sink", () => {
  const m = new IssueManager();
  m.addIssue({ title: "a", severity: "warning", sinkId: "s1" });
  m.addIssue({ title: "b", severity: "warning", sinkId: "s2" });
  m.clearTopIssueForSink("s2");
  assert.equal(m.issuesNow().length, 2);
  m.clearTopIssueForSink("s1");
  assert.deepEqual(m.issuesNow().map((i) => i.info.title), ["b"]);
  m.dispose();
});

test("IssueManager: the permission rejected issue replaces the others and has no timeout", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const m = new IssueManager();
    const seen: Issue[] = [];
    m.registerObserver({ onIssue: (i) => seen.push(i) });
    m.addIssue({ title: "a", severity: "warning" });
    m.addPermissionRejectedIssue();
    assert.equal(m.issuesNow().length, 1);
    assert.equal(seen.at(-1)?.isPermissionRejectedIssue, true);
    mock.timers.tick(10 * 60_000);
    assert.equal(m.issuesNow().length, 1);
    m.dispose();
  } finally {
    mock.timers.reset();
  }
});

test("IssueManager: a throwing observer does not stop the others", () => {
  const m = new IssueManager();
  const quiet = console.error;
  console.error = () => {};
  try {
    const got: string[] = [];
    m.registerObserver({ onIssue: () => { throw new Error("boom"); } });
    m.registerObserver({ onIssue: (i) => got.push(i.info.title) });
    m.addIssue({ title: "a", severity: "warning" });
    assert.deepEqual(got, ["a"]);
  } finally {
    console.error = quiet;
  }
  m.dispose();
});

test("RouterIssues: a declined launch clears the pending notice and raises nothing, a timeout raises Failed to cast", () => {
  const m = new IssueManager();
  const r = new RouterIssues(m);
  r.pendingUserAuth({ id: "s", name: "TV" });
  assert.equal(m.issuesNow().length, 1);
  r.launchFailed("user_not_allowed", "s", "");
  assert.equal(m.issuesNow().length, 0);
  r.launchFailed("notification_disabled", "s", "");
  assert.equal(m.issuesNow().length, 0);
  r.launchFailed("timed_out", "s", "");
  assert.equal(m.issuesNow()[0]?.info.title, "Failed to cast. Please try again.");
  m.dispose();
});

test("RouterIssues: DIAL cannot-terminate, mac-only issues and the permission feature gate", () => {
  const m = new IssueManager();
  const r = new RouterIssues(m, { mac: false, showPermissionRejectedError: false });
  r.cannotTerminate("d");
  assert.equal(m.issuesNow()[0]?.info.title, "Use remote to stop casting");
  assert.equal(m.issuesNow()[0]?.info.severity, "warning");
  r.uiScreenPermission("d");
  r.desktopAudioNotSupportedAtLaunch("desktop_mirror", false, "d");
  assert.equal(m.issuesNow().length, 1);
  r.localDiscoveryPermissionRejected();
  assert.equal(m.issuesNow().some((i) => i.isPermissionRejectedIssue), false);
  const mac = new RouterIssues(m, { mac: true });
  mac.uiScreenPermission("d");
  mac.localDiscoveryPermissionRejected();
  assert.equal(m.issuesNow().length, 1);
  assert.equal(m.issuesNow()[0]?.isPermissionRejectedIssue, true);
  m.dispose();
});

test("classifyLaunchFailure and originNameForDisplay", () => {
  assert.equal(classifyLaunchFailure(new CastTimeoutError("x")), "timed_out");
  const e = (extended: string) => new CastRequestError({ type: "LAUNCH_ERROR", requestId: 1, reason: "CANCELLED", extendedError: extended } as never);
  assert.equal(classifyLaunchFailure(e("USER_NOT_ALLOWED")), "user_not_allowed");
  assert.equal(classifyLaunchFailure(e("USER_NOTIFICATIONS_DISABLED")), "notification_disabled");
  assert.equal(classifyLaunchFailure(new Error("x")), "error");
  assert.equal(originNameForDisplay("https://music.example.test"), "music.example.test");
});

test("MediaRouterLogger keeps the last 1000 entries and truncates long fields", () => {
  const log = new MediaRouterLogger();
  const seen: string[] = [];
  log.addObserver((e) => seen.push(e.message));
  for (let i = 0; i < 1005; i++) log.info("Discovery", "C", `m${i}`);
  const all = log.getLogs();
  assert.equal(all.length, 1000);
  assert.equal(all[0]?.message, "m5");
  assert.equal(seen.length, 1005);
  log.error("Route", "x".repeat(100), "y".repeat(2000), { sinkId: "z".repeat(100) });
  const last = log.getLogs().at(-1)!;
  assert.equal(last.severity, "Error");
  assert.ok(last.message.length <= 1024);
  assert.ok(last.component.length <= 64);
  log.dispose();
});

test("switches: features, the playout delay, fixed devices", () => {
  assert.equal(mediaRouterFeatureEnabled(undefined), true);
  assert.equal(mediaRouterFeatureEnabled(line({ "disable-features": "Foo,MediaRouter" })), false);
  assert.equal(featureEnabled(line({ "enable-features": "MediaRouter", "disable-features": "MediaRouter" }), "MediaRouter", true), false);
  assert.equal(castAllowAllIpsFeature(undefined), false);
  assert.equal(castAllowAllIpsFeature(line({ "enable-features": "CastAllowAllIPs" })), true);
  assert.equal(showCastPermissionRejectedError(line({ "disable-features": "ShowCastPermissionRejectedError" })), false);
  assert.equal(castDesktopMirroringKeepLocalAudio(line({ "disable-features": "CastDesktopMirroringKeepLocalAudio" })), false);
  const delay = (v: string) => castMirroringPlayoutDelayMs(line({ "cast-mirroring-target-playout-delay": v }));
  assert.equal(delay("250"), 250);
  assert.equal(delay("0"), undefined);
  assert.equal(delay("1001"), undefined);
  assert.equal(delay("abc"), undefined);
  const devices = fixedCastDevices(line({ "cast-device-ips": "10.0.0.5, 10.0.0.6:9000,[::1],nope,10.0.0.7:99999" }));
  assert.deepEqual(devices.map((d) => [d.host, d.port, d.name]), [
    ["10.0.0.5", 8009, "Receiver-10_0_0_5"], ["10.0.0.6", 9000, "Receiver-10_0_0_6"], ["::1", 8009, "Receiver-::1"],
  ]);
  assert.equal(devices[0]?.capabilities, 5);
});

test("switches: developer certificates give nothing for a missing file or no PEM", () => {
  const warnings: string[] = [];
  assert.deepEqual(developerCertificates(line({ "cast-developer-certificate-path": join(tmpdir(), "no-such-file.pem") }), (m) => warnings.push(m)), []);
  const dir = mkdtempSync(join(tmpdir(), "cast-cert-"));
  const file = join(dir, "empty.pem");
  writeFileSync(file, "nothing here");
  assert.deepEqual(developerCertificates(line({ "cast-developer-certificate-path": file }), (m) => warnings.push(m)), []);
  assert.equal(warnings.length, 2);
});

class Ipc implements IpcMainLike {
  handlers = new Map<string, (event: any, ...args: any[]) => unknown>();
  handle(channel: string, listener: (event: any, ...args: any[]) => unknown): void {
    this.handlers.set(channel, listener);
  }
  removeHandler(channel: string): void {
    this.handlers.delete(channel);
  }
  on(): unknown {
    return this;
  }
  removeListener(): unknown {
    return this;
  }
}

class Discovery extends FakeDevices {
  started = 0;
  async start(): Promise<void> {
    this.started++;
  }
  stop(): void {}
}

function manager(commandLine?: CommandLineLike) {
  const discovery = new Discovery();
  const m = createCastManager({
    sinks: FAST_SINKS,
    ipcMain: new Ipc(),
    discovery,
    ...(commandLine === undefined ? {} : { commandLine }),
    createClient: (d: never) => {
      const c = new FakeClient(d);
      c.echoReplies = true;
      return c;
    },
    selectDevice: async (devices: { id: string }[]) => devices.find((d) => d.id === TV.id) ?? null,
  } as never);
  return { m, discovery };
}

test("MediaRouter disabled: start discovers nothing, and addSinkByAddress is refused", async () => {
  const { m, discovery } = manager(line({ "disable-features": "MediaRouter" }));
  await m.start();
  assert.equal(discovery.started, 0);
  assert.equal(m.getCastProviderState(), null);
  await assert.rejects(m.addSinkByAddress({ host: "10.0.0.9" } as never));
  m.dispose();
});

test("the manager API: issues observers, clearIssue and the log", async () => {
  const { m, discovery } = manager();
  await m.start();
  assert.equal(discovery.started, 1);
  const seen: string[] = [];
  const stop = m.registerIssuesObserver({ onIssue: (i) => seen.push(i.info.title), onIssuesCleared: () => seen.push("cleared") });
  assert.deepEqual(m.getCastProviderState(), { sessionState: [] });
  assert.throws(() => m.registerIssuesObserver(null as never), TypeError);
  assert.throws(() => m.clearIssue("1" as never), TypeError);
  m.clearIssue(12345);
  m.clearTopIssueForSink("none");
  stop();
  assert.deepEqual(seen, []);
  assert.ok(Array.isArray(m.getLogs()));
  m.dispose();
  await tick();
});
