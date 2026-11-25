// Mirroring to flinging (SwitchToFlingingIfPossible, CastActivityManager::JoinSession), site-initiated mirroring
// (kPresentationApiAllowlist) and the desktop capture escalation guard (MediaRouterDesktop::IsDesktopCaptureEscalation).
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createCastManager, type CastManagerOptions, type IpcMainEventLike, type IpcMainLike } from "../../src/electron/main.ts";
import {
  AUTO_JOIN_PRESENTATION_ID, PRESENTATION_API_ALLOWLIST, isDesktopCaptureEscalation, isSiteInitiatedMirroringSource, mayFling,
  siteInitiatedMirroringAllowed, siteMirroringSource,
} from "../../src/electron/mirroring-to-flinging.ts";
import { chooseSource } from "../../src/electron/presentation-source.ts";
import { desktopMediaSource, tabMediaSource, type MirroringSource } from "../../src/mirroring/routing.ts";
import { FakeDevices, FakeClient, TV, FAST_SINKS, tick } from "./fakes.ts";

const ORIGIN = "https://music.youtube.com";
const APP_URL = "https://google.com/cast#__castAppId__=233637DE/__castClientId__=c1";
const APP_URL_THIS_TAB = "https://google.com/cast#__castAppId__=233637DE/__castClientId__=c1/__castDefaultActionPolicy__=cast_this_tab";
const STREAMING_URL = "cast:0F5096E8";

// ---- pure rules ------------------------------------------------------------------------------------------------------

test("IsDesktopCaptureEscalation: only a desktop source is ever an escalation, and auto-join or an unknown route is one", () => {
  const desktop = desktopMediaSource("screen:0:0", false);
  const tab = tabMediaSource(4);
  const routes = [
    { presentationId: "mr_tab", mediaSource: tab },
    { presentationId: "mr_desktop", mediaSource: desktop },
    { presentationId: "cast-session_x", mediaSource: "cast:233637DE" },
  ];
  assert.equal(isDesktopCaptureEscalation("cast:233637DE", AUTO_JOIN_PRESENTATION_ID, routes), false, "a non-desktop source is not checked");
  assert.equal(isDesktopCaptureEscalation(tab, "mr_tab", routes), false);
  assert.equal(isDesktopCaptureEscalation(desktop, AUTO_JOIN_PRESENTATION_ID, routes), true, "auto-join never reaches desktop capture");
  assert.equal(isDesktopCaptureEscalation(desktop, "mr_tab", routes), true, "a route that is not desktop capture is not upgraded");
  assert.equal(isDesktopCaptureEscalation(desktop, "cast-session_x", routes), true);
  assert.equal(isDesktopCaptureEscalation(desktop, "mr_desktop", routes), false, "joining a desktop route is not an escalation");
  assert.equal(isDesktopCaptureEscalation(desktop, "mr_gone", routes), true, "a route that does not exist counts as one");
  assert.equal(isDesktopCaptureEscalation("urn:x-org.chromium.media:source:desktop", "mr_tab", routes), true, "the unchosen desktop source is one too");
});

test("GetOrigins: the allowlist is matched by origin, and AllowAllSitesToInitiateMirroring lifts it", () => {
  assert.deepEqual([...PRESENTATION_API_ALLOWLIST], ["https://docs.google.com", "https://meet.google.com", "https://music.youtube.com"]);
  for (const origin of PRESENTATION_API_ALLOWLIST) assert.equal(siteInitiatedMirroringAllowed(origin), true, origin);
  assert.equal(siteInitiatedMirroringAllowed("https://docs.google.com:443"), true, "the default port is the same origin");
  assert.equal(siteInitiatedMirroringAllowed("https://example.com"), false);
  assert.equal(siteInitiatedMirroringAllowed("http://docs.google.com"), false, "the scheme counts");
  assert.equal(siteInitiatedMirroringAllowed("https://docs.google.com:8443"), false, "the port counts");
  assert.equal(siteInitiatedMirroringAllowed("https://evil.docs.google.com"), false);
  assert.equal(siteInitiatedMirroringAllowed("not a url"), false);
  const line = (switches: Record<string, string>) => ({
    hasSwitch: (n: string) => n in switches,
    getSwitchValue: (n: string) => switches[n] ?? "",
  });
  assert.equal(siteInitiatedMirroringAllowed("https://example.com", line({ "enable-features": "Other,AllowAllSitesToInitiateMirroring" })), true);
  assert.equal(siteInitiatedMirroringAllowed("https://example.com", line({ "enable-features": "AllowAllSitesToInitiateMirroring", "disable-features": "AllowAllSitesToInitiateMirroring" })), false);
  assert.equal(siteInitiatedMirroringAllowed("https://example.com", line({ "enable-features": "Other" })), false);
});

test("IsSiteInitiatedMirroringSource: a Cast URL with a streaming app, in either form; not the browser's URNs", () => {
  assert.equal(isSiteInitiatedMirroringSource("cast:0F5096E8"), true);
  assert.equal(isSiteInitiatedMirroringSource("cast:85CDB22F?clientId=1"), true);
  assert.equal(isSiteInitiatedMirroringSource("https://google.com/cast#__castAppId__=233637DE/__castAppId__=0F5096E8"), true);
  assert.equal(isSiteInitiatedMirroringSource("cast:233637DE"), false);
  assert.equal(isSiteInitiatedMirroringSource(tabMediaSource(3)), false);
  assert.equal(isSiteInitiatedMirroringSource(desktopMediaSource("screen:0:0", true)), false);
  assert.equal(isSiteInitiatedMirroringSource("remote-playback:foo"), false);
  const source = siteMirroringSource("cast:0F5096E8", 9) as MirroringSource;
  assert.deepEqual({ id: source.id, type: source.type, tabId: source.tabId, apps: source.appInfos.map((a) => a.appId) },
    { id: "cast:0F5096E8", type: "tab", tabId: 9, apps: ["0F5096E8"] });
  assert.equal(siteMirroringSource("cast:233637DE", 9), undefined);
});

test("DefaultActionPolicy: only cast_this_tab keeps a mirrored tab mirrored", () => {
  assert.equal(mayFling("create_session"), true);
  assert.equal(mayFling("cast_this_tab"), false);
  assert.equal(mayFling("anything else"), true, "an unknown value is create_session");
});

test("chooseSource serves a streaming URL only when the origin may start mirroring, in URL order", () => {
  assert.equal(chooseSource([STREAMING_URL]).kind, "no_sink");
  assert.equal(chooseSource([STREAMING_URL], { mirroring: false }).kind, "no_sink");
  const choice = chooseSource([STREAMING_URL, "cast:233637DE"], { mirroring: true });
  assert.ok(choice.kind === "launch" && choice.mirroring === true && choice.url === STREAMING_URL);
  const second = chooseSource(["cast:233637DE", STREAMING_URL], { mirroring: true });
  assert.ok(second.kind === "launch" && second.mirroring === undefined && second.url === "cast:233637DE");
  assert.equal(chooseSource([STREAMING_URL, "cast:233637DE"], { mirroring: false }).kind, "launch");
});

// ---- the wiring ------------------------------------------------------------------------------------------------------

type Listener = (event: IpcMainEventLike, ...args: any[]) => void;
class FakeIpcMain implements IpcMainLike {
  handlers = new Map<string, (event: any, ...args: any[]) => unknown>();
  listeners = new Map<string, Listener[]>();
  handle(channel: string, listener: (event: any, ...args: any[]) => unknown): void {
    this.handlers.set(channel, listener);
  }
  removeHandler(channel: string): void {
    this.handlers.delete(channel);
  }
  on(channel: string, listener: Listener): unknown {
    this.listeners.set(channel, [...(this.listeners.get(channel) ?? []), listener]);
    return this;
  }
  removeListener(channel: string, listener: Listener): unknown {
    this.listeners.set(channel, (this.listeners.get(channel) ?? []).filter((l) => l !== listener));
    return this;
  }
}

class FakeWebContents extends EventEmitter {
  readonly id: number;
  sent: { channel: string; payload: any }[] = [];
  constructor(id: number) {
    super();
    this.id = id;
  }
  send(channel: string, payload: unknown): void {
    this.sent.push({ channel, payload: JSON.parse(JSON.stringify(payload)) });
  }
  isDestroyed(): boolean {
    return false;
  }
  events(): any[] {
    return this.sent.filter((s) => s.channel === "electron-cast:presentation:event").map((s) => s.payload);
  }
  /** The types of the envelopes the page was sent on a connection. */
  messageTypes(connectionId: string): string[] {
    return this.events()
      .filter((e) => e.type === "message" && e.connectionId === connectionId)
      .map((e) => (JSON.parse(e.data) as { type: string }).type);
  }
}

class FakeDiscovery extends FakeDevices {
  async start(): Promise<void> {}
  stop(): void {}
}

function setup(over: Partial<CastManagerOptions> = {}) {
  const ipcMain = new FakeIpcMain();
  const devices = new FakeDiscovery();
  const clients: FakeClient[] = [];
  const stops: string[] = [];
  const sources: MirroringSource[] = [];
  const picked: unknown[] = [];
  const manager = createCastManager({
    sinks: FAST_SINKS,
    ipcMain,
    discovery: devices,
    createClient: (d) => {
      const c = new FakeClient(d);
      clients.push(c);
      return c;
    },
    selectDevice: async (list, request) => {
      picked.push(request);
      return list.find((d) => d.id === TV.id) ?? null;
    },
    mirroring: {
      createService: (_params, _observer, _channel, source) => {
        sources.push(source);
        return { onMessage() {}, stop: () => void stops.push("stop"), switchMirroringSourceTab() {} };
      },
    },
    ...over,
  });
  const frame = (origin: string) => ({ url: `${origin}/`, origin });
  const pcall = (wc: FakeWebContents, method: string, params: any, origin = ORIGIN) =>
    Promise.resolve(ipcMain.handlers.get("electron-cast:presentation")!({ sender: wc, senderFrame: frame(origin) }, method, params)) as Promise<any>;
  const launches = () => clients.flatMap((c) => c.calls.filter((x) => x.startsWith("launch ")));
  return { manager, pcall, clients, stops, sources, picked, launches };
}

test("a page's auto-join on a mirrored tab launches its app on the mirroring sink and ends the mirroring (JoinSession)", async () => {
  const { manager, pcall, stops, launches } = setup();
  await manager.settled();
  const wc = new FakeWebContents(7);
  const mirror = await manager.startCasting(TV.id, { castMode: "tab_mirror", webContentsId: 7 });
  assert.deepEqual(launches(), ["launch 0F5096E8"]);

  const joined = await pcall(wc, "reconnect", { connectionId: "k1", urls: [APP_URL], presentationId: "auto-join" });
  assert.equal(joined.ok, true, JSON.stringify(joined));
  assert.equal(joined.value.id, "auto-join", "the route's presentation id stays auto-join");
  assert.deepEqual(launches(), ["launch 0F5096E8", "launch 233637DE"]);
  assert.deepEqual(wc.messageTypes("k1"), ["receiver_action", "new_session"], "a launch, not a join: the receiver action comes first");
  for (let i = 0; i < 20 && manager.getRoutes().some((r) => r.id === mirror.id); i++) await tick();
  assert.equal(manager.getRoutes().some((r) => r.id === mirror.id), false, "the frame's mirroring route ended with the launch");
  assert.deepEqual(stops, ["stop"]);
  assert.equal(manager.getRoutes().filter((r) => r.appId === "233637DE").length, 1);
  await manager.dispose();
});

test("an auto-join with defaultActionPolicy cast_this_tab leaves the tab mirrored, and so does a tab that is not mirrored", async () => {
  const { manager, pcall, stops, launches } = setup();
  await manager.settled();
  const wc = new FakeWebContents(7);
  const other = new FakeWebContents(8);
  await manager.startCasting(TV.id, { castMode: "tab_mirror", webContentsId: 7 });

  const kept = await pcall(wc, "reconnect", { connectionId: "k1", urls: [APP_URL_THIS_TAB], presentationId: "auto-join" });
  assert.equal(kept.ok, false);
  assert.equal(kept.code, "NotFoundError");
  const notMirrored = await pcall(other, "reconnect", { connectionId: "k2", urls: [APP_URL], presentationId: "auto-join" });
  assert.equal(notMirrored.ok, false);
  assert.equal(notMirrored.code, "NotFoundError");
  assert.deepEqual(launches(), ["launch 0F5096E8"], "nothing but the mirroring app was launched");
  assert.deepEqual(stops, []);
  assert.equal(manager.getRoutes().length, 1);
  await manager.dispose();
});

test("the auto-join of a page that has a Cast session of its own joins it instead of flinging", async () => {
  const { manager, pcall, launches } = setup();
  await manager.settled();
  const wc = new FakeWebContents(7);
  // Chrome's default policy is page_scoped, which never auto-joins (`FindActivityForAutoJoin` returns null for it), so the
  // page asks for origin_scoped
  const joinUrl = `${APP_URL}/__castAutoJoinPolicy__=origin_scoped`;
  const started = await pcall(wc, "start", { connectionId: "s1", urls: [joinUrl], hasGesture: true });
  assert.equal(started.ok, true, JSON.stringify(started));
  const mirror = await manager.startCasting(TV.id, { castMode: "tab_mirror", webContentsId: 8 });
  assert.ok(mirror.id);
  const before = launches().length;
  const joined = await pcall(wc, "reconnect", { connectionId: "k1", urls: [joinUrl], presentationId: "auto-join" });
  assert.equal(joined.ok, true, JSON.stringify(joined));
  assert.equal(launches().length, before, "FindActivityForAutoJoin found the activity: no launch");
  await manager.dispose();
});

test("switching the mirrored tab to a page with a default request flings it (SwitchToFlingingIfPossible)", async () => {
  const { manager, pcall, stops, launches } = setup();
  await manager.settled();
  const wc = new FakeWebContents(7);
  assert.equal((await pcall(wc, "setDefaultRequest", { urls: [APP_URL] })).ok, true);
  const mirror = await manager.startCasting(TV.id, { castMode: "tab_mirror", webContentsId: 5 });

  manager.switchMirroringSourceTab(mirror.id, 7);
  for (let i = 0; i < 40 && launches().length < 2; i++) await tick();
  assert.deepEqual(launches(), ["launch 0F5096E8", "launch 233637DE"]);
  const available = wc.events().filter((e) => e.type === "connectionavailable");
  assert.equal(available.length, 1, "the page is handed the connection of its default request");
  assert.equal(available[0].id, "auto-join");
  for (let i = 0; i < 20 && manager.getRoutes().some((r) => r.id === mirror.id); i++) await tick();
  assert.equal(manager.getRoutes().some((r) => r.id === mirror.id), false);
  assert.deepEqual(stops, ["stop"]);
  await manager.dispose();
});

test("a switch to a page with no default request, or one that says cast_this_tab, changes nothing", async () => {
  const { manager, pcall, stops, launches } = setup();
  await manager.settled();
  const plain = new FakeWebContents(7);
  const thisTab = new FakeWebContents(9);
  await pcall(plain, "getAvailability", { watchId: "w", urls: [APP_URL] });
  await pcall(thisTab, "setDefaultRequest", { urls: [APP_URL_THIS_TAB] });
  const mirror = await manager.startCasting(TV.id, { castMode: "tab_mirror", webContentsId: 5 });
  manager.switchMirroringSourceTab(mirror.id, 7);
  await tick();
  await tick();
  manager.switchMirroringSourceTab(mirror.id, 9);
  await tick();
  await tick();
  assert.deepEqual(launches(), ["launch 0F5096E8"]);
  assert.deepEqual(stops, []);
  assert.equal(manager.getRoutes().length, 1);
  assert.equal(thisTab.events().some((e) => e.type === "connectionavailable"), false);
  await manager.dispose();
});

test("a page of an allowlisted origin starts mirroring with a streaming URL; the page's tab is the source", async () => {
  const origin = "https://docs.google.com";
  const { manager, pcall, sources, picked, launches, stops } = setup();
  await manager.settled();
  const wc = new FakeWebContents(6);
  const watch = await pcall(wc, "getAvailability", { watchId: "w1", urls: [STREAMING_URL] }, origin);
  assert.deepEqual(watch, { ok: true, value: { available: true } }, "Chrome offers the source's sinks to this origin");

  const started = await pcall(wc, "start", { connectionId: "m1", urls: [STREAMING_URL], hasGesture: true }, origin);
  assert.equal(started.ok, true, JSON.stringify(started));
  assert.equal(picked.length, 1, "the user picked the sink: Chrome's dialog is the consent");
  assert.deepEqual(launches(), ["launch 0F5096E8"]);
  assert.equal(sources.length, 1);
  assert.deepEqual({ id: sources[0]!.id, type: sources[0]!.type, tabId: sources[0]!.tabId }, { id: STREAMING_URL, type: "tab", tabId: 6 });
  const routes = manager.getRoutes();
  assert.equal(routes.length, 1);
  assert.equal(routes[0]!.mediaSource, STREAMING_URL);
  assert.deepEqual(routes[0]!.members, [6]);
  assert.ok(started.value.id.startsWith("mr_"));
  assert.deepEqual(wc.messageTypes("m1"), [], "no client id in the URL: nothing is sent");

  // the receiver ending the route ends the page's connection; terminating from the page stops the mirroring
  wc.sent.length = 0;
  await pcall(wc, "terminate", { connectionId: "m1" }, origin);
  for (let i = 0; i < 20 && manager.getRoutes().length > 0; i++) await tick();
  assert.deepEqual(stops, ["stop"]);
  assert.deepEqual(manager.getRoutes(), []);
  assert.ok(wc.events().some((e) => e.type === "statechange" && e.connectionId === "m1" && e.state === "terminated"));
  await manager.dispose();
});

test("a page of another origin cannot start mirroring: no screens, unavailable", async () => {
  const { manager, pcall, launches } = setup();
  await manager.settled();
  const wc = new FakeWebContents(6);
  const watch = await pcall(wc, "getAvailability", { watchId: "w1", urls: [STREAMING_URL] }, "https://example.com");
  assert.deepEqual(watch, { ok: true, value: { available: false } });
  const started = await pcall(wc, "start", { connectionId: "m1", urls: [STREAMING_URL], hasGesture: true }, "https://example.com");
  assert.equal(started.ok, false);
  assert.equal(started.code, "NotFoundError");
  assert.deepEqual(launches(), []);
  assert.deepEqual(manager.getRoutes(), []);
  await manager.dispose();
});

test("a page that starts site-initiated mirroring loses the session it launched; its mirroring route cannot be joined", async () => {
  const origin = "https://docs.google.com";
  const { manager, pcall } = setup();
  await manager.settled();
  const wc = new FakeWebContents(6);
  const session = await pcall(wc, "start", { connectionId: "s1", urls: [APP_URL], hasGesture: true }, origin);
  assert.equal(session.ok, true, JSON.stringify(session));
  const started = await pcall(wc, "start", { connectionId: "m1", urls: [STREAMING_URL], hasGesture: true }, origin);
  assert.equal(started.ok, true, JSON.stringify(started));
  for (let i = 0; i < 20 && manager.getRoutes().some((r) => r.mediaSource !== STREAMING_URL); i++) await tick();
  assert.deepEqual(manager.getRoutes().map((r) => r.mediaSource), [STREAMING_URL], "one route per frame");
  const rejoin = await pcall(wc, "reconnect", { connectionId: "m2", urls: [STREAMING_URL], presentationId: started.value.id }, origin);
  assert.equal(rejoin.ok, false);
  assert.equal(rejoin.code, "NotFoundError");
  await manager.dispose();
});

test("the default request of a window can be a streaming URL: startCasting mirrors the window's tab", async () => {
  const origin = "https://meet.google.com";
  const { manager, pcall, sources } = setup();
  await manager.settled();
  const wc = new FakeWebContents(6);
  assert.equal((await pcall(wc, "setDefaultRequest", { urls: [STREAMING_URL] }, origin)).ok, true);
  const route = await manager.startCasting(TV.id, { webContentsId: 6 });
  assert.equal(route.mediaSource, STREAMING_URL);
  assert.equal(sources[0]!.tabId, 6);
  assert.equal(wc.events().filter((e) => e.type === "connectionavailable").length, 1);
  await manager.dispose();
});

test("JoinRoute refuses a desktop capture source that would escalate a route, with USER_NOT_ALLOWED's text", async () => {
  const { manager, pcall, launches } = setup();
  await manager.settled();
  const wc = new FakeWebContents(7);
  const desktop = desktopMediaSource("screen:0:0", false);
  // with no route at all JoinRoute fails earlier ("Route not found"); here the source is simply not one this library serves
  const none = await pcall(wc, "reconnect", { connectionId: "k0", urls: [desktop], presentationId: "auto-join" });
  assert.equal(none.ok, false);
  assert.notEqual(none.description, "Cannot switch to desktop capture without user consent");

  await manager.startCasting(TV.id, { castMode: "tab_mirror", webContentsId: 7 });
  const refused = await pcall(wc, "reconnect", { connectionId: "k1", urls: [desktop], presentationId: "auto-join" });
  assert.deepEqual({ ok: refused.ok, code: refused.code, description: refused.description },
    { ok: false, code: "NotFoundError", description: "Cannot switch to desktop capture without user consent" });
  const byId = await pcall(wc, "reconnect", { connectionId: "k2", urls: [desktop], presentationId: "cast-session_whatever" });
  assert.equal(byId.description, "Cannot switch to desktop capture without user consent");
  assert.deepEqual(launches(), ["launch 0F5096E8"]);
  await manager.dispose();
});
