// DIAL through the manager's presentation IPC: a page with the Google Cast SDK sends cast-dial: sources, and the
// manager discovers DIAL devices (a fake SSDP socket and a scripted HTTP layer), offers them in the picker, and runs
// the SDK's custom_dial_launch round trip. Cast and DIAL sinks together follow Chrome's rules (dedup, origins).
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createCastManager, type CastManagerOptions, type IpcMainEventLike, type IpcMainLike } from "../../src/electron/main.ts";
import type { CastDevice } from "../../src/discovery/index.ts";
import { FakeDevices, FakeClient, FAST_SINKS, TV, device, tick } from "./fakes.ts";
import { APP_URL, DEVICE_IP, FakeHttp, SINK_ID, UDN, appInfoXml, descriptionXml, ok, ssdpAnswer, DESCRIPTION_URL } from "../dial/fixtures.ts";

const ORIGIN = "https://www.youtube.com";
const DIAL_URL = "cast-dial:YouTube?dialPostData=pair%3D1&clientId=c1";
const CAST_URL = "cast:233637DE?clientId=c1";
const RUN_URL = `${APP_URL}/YouTube`;

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
  /** The router messages the page received on a connection, parsed. */
  messages(connectionId: string): any[] {
    return this.events().filter((e) => e.type === "message" && e.connectionId === connectionId).map((e) => JSON.parse(e.data));
  }
}

class FakeDiscovery extends FakeDevices {
  async start(): Promise<void> {}
  stop(): void {}
}

function dialHttp(state: "running" | "stopped" = "stopped"): FakeHttp {
  return new FakeHttp()
    .reply("GET", DESCRIPTION_URL, ok(descriptionXml(), { "application-url": `${APP_URL}/` }))
    .reply("GET", RUN_URL, ok(appInfoXml(state)))
    .reply("POST", RUN_URL, ok("", { location: `http://${DEVICE_IP}:8008/apps/YouTube/run` }, 201))
    .reply("DELETE", `http://${DEVICE_IP}:8008/apps/YouTube/run`, ok());
}

/** A manager with a Cast fake and a DIAL device that answers the first search; waits until DIAL has published it. */
async function setup(over: { warm?: boolean; cast?: CastDevice[]; http?: FakeHttp; dial?: CastManagerOptions["dial"]; pick?: (list: CastDevice[]) => CastDevice | null } = {}) {
  const ipcMain = new FakeIpcMain();
  const http = over.http ?? dialHttp();
  const clients: FakeClient[] = [];
  const picked: CastDevice[][] = [];
  const manager = createCastManager({
    ipcMain,
    discovery: new FakeDiscovery(over.cast ?? []),
    // Cast devices are sinks once their channel is open; open them without Chrome's random delay
    sinks: FAST_SINKS,
    createClient: (d) => {
      const c = new FakeClient(d);
      // The DIAL device is a TV with no Cast channel: the manager tries port 8009 on it (Chrome's promotion of DIAL
      // sinks, see dial-promotion.test.ts) and nothing answers, so it stays a DIAL sink.
      if (d.host === DEVICE_IP && d.port === 8009) {
        c.connectError = new Error("connection refused");
        return c;
      }
      clients.push(c);
      return c;
    },
    selectDevice: async (list) => {
      picked.push(list);
      return over.pick ? over.pick(list) : (list.find((d) => d.dial !== undefined) ?? list[0] ?? null);
    },
    dial: over.dial ?? {
      http,
      settleMs: 5,
      registry: {
        interfaces: () => [{ name: "lo", address: "127.0.0.1" }],
        openSocket: async (_iface, handlers) => ({
          send() {
            queueMicrotask(() => handlers.message(Buffer.from(ssdpAnswer(), "latin1"), { address: DEVICE_IP, port: 1900 }));
          },
          close() {},
        }),
        requestIntervalMs: 5,
        responseTimeoutMs: 20,
        maxRequests: 1,
      },
    },
  });
  await manager.start();
  await manager.settled();
  await tick(80);
  const pcall = (wc: FakeWebContents, method: string, params: any, origin = ORIGIN) => {
    const h = ipcMain.handlers.get("electron-cast:presentation");
    assert.ok(h);
    const sent = method === "start" ? { hasGesture: true, ...params } : params;
    return Promise.resolve(h({ sender: wc, senderFrame: { url: `${origin}/`, origin } }, method, sent)) as Promise<any>;
  };
  const psend = (wc: FakeWebContents, connectionId: string, data: unknown) => {
    for (const l of ipcMain.listeners.get("electron-cast:presentation:send") ?? []) l({ sender: wc }, connectionId, JSON.stringify(data));
  };
  if (over.warm !== false) {
    // The SDK watches availability before anything starts; that is what makes the manager ask devices about the app.
    await pcall(new FakeWebContents(99), "getAvailability", { watchId: "warm", urls: [DIAL_URL] });
    await tick(40);
  }
  return { manager, http, clients, picked, pcall, psend };
}

const envelope = (type: string, message: unknown, sequenceNumber?: number) =>
  ({ type, message, clientId: "c1", ...(sequenceNumber === undefined ? {} : { sequenceNumber }), timeoutMillis: 0 });

test("a DIAL device is a sink, with the generic icon and the dial provider, once its description and app answer", async () => {
  const { manager } = await setup();
  const seen: any[][] = [];
  const stop = manager.registerMediaSinksObserver({ onSinksUpdated: (s) => seen.push(s) });
  assert.equal(seen[0]?.length, 1);
  assert.deepEqual(
    { id: seen[0]![0].id, providerId: seen[0]![0].providerId, iconType: seen[0]![0].iconType, name: seen[0]![0].name, description: seen[0]![0].description },
    { id: SINK_ID, providerId: "dial", iconType: "generic", name: "Living Room TV", description: "Smart TV" },
  );
  assert.equal(seen[0]![0].device.dial.ipAddress, DEVICE_IP);
  const caps: any[][] = [];
  manager.registerMediaSinksObserver({ onSinksUpdated: (s) => caps.push(s) }, { capabilities: ["video_out"] })();
  assert.deepEqual(caps[0], [], "a DIAL sink has no Cast capabilities");
  assert.deepEqual(manager.devices(), [], "devices() stays the Cast devices");
  stop();
  await manager.dispose();
});

test("availability: a cast-dial source becomes available once the device answers for the app, and only to the origins Chrome allows", async () => {
  const { manager, pcall } = await setup({ warm: false });
  const wc = new FakeWebContents(1);
  // Like Chrome's, the first answer is what is known now; the app query is still on its way.
  assert.deepEqual(await pcall(wc, "getAvailability", { watchId: "a", urls: [DIAL_URL] }), { ok: true, value: { available: false } });
  await tick(40);
  assert.deepEqual(wc.events().at(-1), { type: "availability", watchId: "a", value: true });
  assert.deepEqual(await pcall(wc, "getAvailability", { watchId: "again", urls: [DIAL_URL] }), { ok: true, value: { available: true } });
  const other = new FakeWebContents(2);
  assert.deepEqual(await pcall(other, "getAvailability", { watchId: "e1", urls: [DIAL_URL] }, "https://evil.example"), { ok: true, value: { available: false } });
  assert.deepEqual(await pcall(wc, "getAvailability", { watchId: "b", urls: ["cast-dial:Netflix?clientId=c1"] }), { ok: true, value: { available: false } }, "no such app");
  await tick(40);
  assert.equal(other.events().length, 0, "an origin that is not allowed never hears of the sink");
  await manager.dispose();
});

test("a request with a Cast URL too is available if either kind is", async () => {
  const { manager, pcall } = await setup();
  const wc = new FakeWebContents(1);
  assert.deepEqual(await pcall(wc, "getAvailability", { watchId: "both", urls: [CAST_URL, DIAL_URL] }), { ok: true, value: { available: true } });
  assert.deepEqual(await pcall(wc, "getAvailability", { watchId: "cast", urls: [CAST_URL] }), { ok: true, value: { available: false } });
  await manager.dispose();
});

test("start with a DIAL choice runs the SDK's launch round trip and a page terminate stops the app", async () => {
  const { manager, pcall, psend, http, picked } = await setup();
  const wc = new FakeWebContents(1);
  const r = await pcall(wc, "start", { connectionId: "k1", urls: [DIAL_URL] });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.match(r.value.id, /^mr_[0-9a-f-]{36}$/);
  assert.equal(r.value.url, DIAL_URL);
  assert.equal(picked[0]?.length, 1);
  assert.deepEqual(wc.messages("k1").map((m) => m.type), ["receiver_action", "new_session"]);
  assert.equal(wc.messages("k1")[1].message.receiver.receiverType, "dial");

  psend(wc, "k1", envelope("client_connect", { clientId: "c1" }));
  await tick(20);
  const ask = wc.messages("k1").find((m) => m.type === "custom_dial_launch");
  assert.ok(ask, "the page is asked whether to launch");
  assert.equal(ask.message.appState, "stopped");
  psend(wc, "k1", envelope("custom_dial_launch", { doLaunch: true, launchParameter: "v=1" }, ask.sequenceNumber));
  await tick(20);
  assert.deepEqual(http.calls.filter((c) => c.method === "POST").map((c) => c.body), ["v=1"]);

  const routes = manager.getRoutes();
  assert.equal(routes.length, 1);
  assert.deepEqual(
    { providerId: routes[0]!.providerId, mediaSource: routes[0]!.mediaSource, sinkId: routes[0]!.sinkId, appId: routes[0]!.appId, members: routes[0]!.members, parked: routes[0]!.parked },
    { providerId: "dial", mediaSource: DIAL_URL, sinkId: SINK_ID, appId: "", members: [1], parked: false },
  );

  assert.deepEqual(await pcall(wc, "terminate", { connectionId: "k1" }), { ok: true, value: undefined });
  await tick(20);
  assert.deepEqual(http.calls.filter((c) => c.method === "DELETE").map((c) => c.url), [`http://${DEVICE_IP}:8008/apps/YouTube/run`]);
  assert.deepEqual(wc.events().at(-1), { type: "statechange", connectionId: "k1", state: "terminated" });
  assert.deepEqual(manager.getRoutes(), []);
  await manager.dispose();
});

test("a DIAL route has no media controller, as Chrome's DIAL provider binds none", async () => {
  const { manager, pcall } = await setup();
  const wc = new FakeWebContents(1);
  const r = await pcall(wc, "start", { connectionId: "k1", urls: [DIAL_URL] });
  assert.equal(r.ok, true, JSON.stringify(r));
  const route = manager.getRoutes()[0]!;
  assert.equal(route.providerId, "dial");
  assert.throws(() => manager.getMediaController(route.id), (err: Error & { code?: string }) => err.code === "route_not_found");
  await manager.dispose();
});

test("a default request with a cast-dial: URL offers the DIAL sink and startCasting on it starts the DIAL route, as Chrome's dialog does", async () => {
  // MediaRouteStarter::OnDefaultPresentationChanged makes a source of each URL, QueryResultManager observes each one,
  // and GetSourceForCastModeAndSink picks the URL the sink is compatible with: the cast-dial: one for a DIAL sink
  const { manager, pcall, psend, http, picked } = await setup({ warm: false });
  const wc = new FakeWebContents(5);
  assert.deepEqual(await pcall(wc, "setDefaultRequest", { urls: [CAST_URL, DIAL_URL] }), { ok: true, value: undefined });
  const lists: any[][] = [];
  const stop = manager.registerMediaSinksObserver({ onSinksUpdated: (s) => lists.push(s) }, { presentationUrls: [CAST_URL, DIAL_URL], origin: ORIGIN });
  await tick(60);
  assert.deepEqual(lists.at(-1)?.map((s) => s.id), [SINK_ID], "the DIAL sink is offered once its DIAL server says it has the app");
  const other: any[][] = [];
  const stopOther = manager.registerMediaSinksObserver({ onSinksUpdated: (s) => other.push(s) }, { presentationUrls: [DIAL_URL], origin: "https://example.test" });
  assert.deepEqual(other.at(-1), [], "not for an origin Chrome does not allow for the app");
  stopOther();
  stop();

  const route = await manager.startCasting(SINK_ID, { webContentsId: 5 });
  assert.equal(picked.length, 0, "no picker");
  assert.equal(route.providerId, "dial");
  assert.equal(route.mediaSource, DIAL_URL);
  assert.equal(route.sinkId, SINK_ID);
  const available = wc.events().find((e) => e.type === "connectionavailable");
  assert.ok(available, "the page gets connectionavailable");
  assert.match(available.id, /^mr_/);
  assert.equal(available.url, DIAL_URL);
  // the SDK's launch round trip runs on that connection as on a page's own start()
  psend(wc, available.connectionId, envelope("client_connect", { clientId: "c1" }));
  await tick(20);
  const ask = wc.messages(available.connectionId).find((m) => m.type === "custom_dial_launch");
  assert.ok(ask);
  psend(wc, available.connectionId, envelope("custom_dial_launch", { doLaunch: true, launchParameter: "v=2" }, ask.sequenceNumber));
  await tick(20);
  assert.deepEqual(http.calls.filter((c) => c.method === "POST").map((c) => c.body), ["v=2"]);
  await manager.dispose();
});

test("a STOP v2_message from the page terminates the connection", async () => {
  const { manager, pcall, psend, http } = await setup();
  const wc = new FakeWebContents(1);
  await pcall(wc, "start", { connectionId: "k1", urls: [DIAL_URL] });
  psend(wc, "k1", envelope("client_connect", {}));
  await tick(20);
  const ask = wc.messages("k1").find((m) => m.type === "custom_dial_launch");
  psend(wc, "k1", envelope("custom_dial_launch", { doLaunch: true }, ask.sequenceNumber));
  await tick(20);
  psend(wc, "k1", envelope("v2_message", { type: "STOP", requestId: 1 }, 5));
  await tick(30);
  assert.equal(http.calls.filter((c) => c.method === "DELETE").length, 1);
  assert.equal(wc.messages("k1").some((m) => m.type === "receiver_action" && m.message.action === "stop"), true);
  assert.deepEqual(wc.events().at(-1), { type: "statechange", connectionId: "k1", state: "terminated" });
  await manager.dispose();
});

test("closing the connection leaves the route and the app running, and a reconnect with the same id joins it", async () => {
  const { manager, pcall, psend, http } = await setup();
  const wc = new FakeWebContents(1);
  const r = await pcall(wc, "start", { connectionId: "k1", urls: [DIAL_URL] });
  psend(wc, "k1", envelope("client_connect", {}));
  await tick(20);
  const ask = wc.messages("k1").find((m) => m.type === "custom_dial_launch");
  psend(wc, "k1", envelope("custom_dial_launch", { doLaunch: true }, ask.sequenceNumber));
  await tick(20);

  await pcall(wc, "close", { connectionId: "k1" });
  assert.deepEqual(wc.events().at(-1), { type: "statechange", connectionId: "k1", state: "closed" });
  assert.equal(http.calls.filter((c) => c.method === "DELETE").length, 0, "nothing is stopped");
  assert.equal(manager.getRoutes().length, 1);
  assert.equal(manager.getRoutes()[0]!.parked, true);

  const joined = await pcall(wc, "reconnect", { connectionId: "k2", urls: [DIAL_URL], presentationId: r.value.id });
  assert.equal(joined.ok, true, JSON.stringify(joined));
  assert.equal(joined.value.id, r.value.id);
  assert.deepEqual(wc.messages("k2"), [], "joining sends no message");
  assert.equal(manager.getRoutes()[0]!.parked, false);

  const wrong = await pcall(wc, "reconnect", { connectionId: "k3", urls: [DIAL_URL], presentationId: "mr_unknown" });
  assert.deepEqual([wrong.ok, wrong.code], [false, "NotFoundError"]);
  const otherPage = await pcall(new FakeWebContents(2), "reconnect", { connectionId: "k4", urls: [DIAL_URL], presentationId: r.value.id }, "https://music.youtube.com");
  assert.deepEqual([otherPage.ok, otherPage.code], [false, "NotFoundError"], "another origin cannot join");

  // The route can be ended from the main process, as Chrome's route controller can.
  await manager.terminateRoute(manager.getRoutes()[0]!.id);
  assert.equal(http.calls.filter((c) => c.method === "DELETE").length, 1);
  assert.deepEqual(wc.events().at(-1), { type: "statechange", connectionId: "k2", state: "terminated" });
  await manager.dispose();
});

test("with both URLs the picked device decides: a Cast device gets the Cast session, with the picker offering both kinds", async () => {
  const cast = device({ id: "ffff0000ffff0000ffff0000ffff0000", name: "Kitchen speaker", capabilities: 5 });
  const { manager, pcall, picked } = await setup({ cast: [cast], pick: (list) => list.find((d) => d.dial === undefined) ?? null });
  const wc = new FakeWebContents(1);
  const r = await pcall(wc, "start", { connectionId: "k1", urls: [CAST_URL, DIAL_URL] });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.match(r.value.id, /^cast-session_/);
  assert.equal(r.value.url, CAST_URL);
  assert.deepEqual(picked[0]?.map((d) => d.id).sort(), [cast.id, SINK_ID].sort());
  await manager.dispose();
});

test("a Cast device that is the same device as a DIAL sink hides the DIAL sink", async () => {
  const same = device({ id: "aaaa1111222233334444555566667777", name: "Living Room TV", capabilities: 5 });
  const { manager, pcall } = await setup({ cast: [same], warm: false });
  const sinks: any[][] = [];
  manager.registerMediaSinksObserver({ onSinksUpdated: (s) => sinks.push(s) });
  assert.deepEqual(sinks.at(-1)?.map((s) => s.id), [same.id], "one sink, the Cast one");
  const wc = new FakeWebContents(1);
  assert.deepEqual(await pcall(wc, "getAvailability", { watchId: "a", urls: [DIAL_URL] }), { ok: true, value: { available: false } });
  await manager.dispose();
});

test("start fails like Chrome when the user cancels, when nothing is available and when the device refuses the launch route", async () => {
  const { manager, pcall } = await setup({ pick: () => null });
  const wc = new FakeWebContents(1);
  const cancelled = await pcall(wc, "start", { connectionId: "k1", urls: [DIAL_URL] });
  assert.deepEqual([cancelled.ok, cancelled.code], [false, "AbortError"]);
  const noApp = await pcall(wc, "start", { connectionId: "k2", urls: ["cast-dial:Netflix?clientId=c1"] });
  assert.deepEqual([noApp.ok, noApp.code], [false, "NotFoundError"]);
  const noClient = await pcall(wc, "start", { connectionId: "k3", urls: ["cast-dial:YouTube"] });
  assert.equal(noClient.ok, false, "a source without a clientId is not a DIAL launch");
  await manager.dispose();
});

test("dial: false switches DIAL off, and a custom discovery leaves it off by default", async () => {
  for (const dial of [false, undefined] as const) {
    const ipcMain = new FakeIpcMain();
    const manager = createCastManager({
      ipcMain,
      discovery: new FakeDiscovery([TV]),
      createClient: (d) => new FakeClient(d),
      sinks: FAST_SINKS,
      selectDevice: async () => null,
      ...(dial === false ? { dial } : {}),
    });
    await manager.start();
    await manager.settled();
    const sinks: any[][] = [];
    manager.registerMediaSinksObserver({ onSinksUpdated: (s) => sinks.push(s) });
    assert.deepEqual(sinks[0]?.map((s) => s.providerId), ["cast"]);
    const h = ipcMain.handlers.get("electron-cast:presentation")!;
    const res = await h({ sender: new FakeWebContents(1), senderFrame: { url: `${ORIGIN}/`, origin: ORIGIN } }, "getAvailability", { watchId: "a", urls: [DIAL_URL] }) as any;
    assert.deepEqual(res, { ok: true, value: { available: false } });
    await manager.dispose();
  }
});

void UDN;

test("start survives a machine with no IPv4 interface: no throw, no unhandled error, the empty list is the answer", async () => {
  const { manager, pcall } = await setup({
    warm: false,
    dial: { http: dialHttp(), settleMs: 5, registry: { interfaces: () => [], refreshMs: 60_000 } },
  });
  const wc = new FakeWebContents(1);
  assert.deepEqual(await pcall(wc, "getAvailability", { watchId: "a", urls: [DIAL_URL] }), { ok: true, value: { available: false } });
  await manager.dispose();
});

test("a socket that fails is logged, and does not throw out of the socket's callback", async () => {
  const logged: string[] = [];
  let fail: (error: Error) => void = () => undefined;
  const { manager } = await setup({
    warm: false,
    dial: {
      http: dialHttp(),
      settleMs: 5,
      log: (m) => logged.push(m),
      registry: {
        interfaces: () => [{ name: "lo", address: "127.0.0.1" }],
        openSocket: async (_iface, handlers) => {
          fail = handlers.error;
          return { send() {}, close() {} };
        },
        refreshMs: 60_000,
        maxRequests: 1,
      },
    },
  });
  assert.doesNotThrow(() => fail(new Error("EADDRNOTAVAIL")));
  assert.deepEqual(logged, ["DIAL discovery error: no_interfaces (EADDRNOTAVAIL)"]);
  await manager.dispose();
});

test("a direct start with no earlier availability watch still finds the DIAL sink", async () => {
  // Chrome's dialog starts observing the source when it opens; the request waits for the devices' answers.
  const { manager, pcall, picked } = await setup({ warm: false });
  const wc = new FakeWebContents(1);
  const r = await pcall(wc, "start", { connectionId: "k1", urls: [DIAL_URL] });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(picked[0]?.length, 1);
  await manager.dispose();
});

test("an origin that may not see the app makes no device request for it", async () => {
  const { manager, pcall, http } = await setup();
  const evil = new FakeWebContents(7);
  await pcall(evil, "getAvailability", { watchId: "e", urls: [DIAL_URL] }, "https://evil.example");
  await pcall(evil, "start", { connectionId: "kx", urls: [DIAL_URL] }, "https://evil.example");
  await tick(30);
  assert.equal(http.calls.filter((c) => c.url === RUN_URL).length, 1, "only the warm-up's own query");
  await manager.dispose();
});

test("many availability watches share one listener on the DIAL service", async () => {
  const warnings: string[] = [];
  const onWarning = (w: Error): void => void warnings.push(w.name);
  process.on("warning", onWarning);
  try {
    const { manager, pcall } = await setup();
    const wc = new FakeWebContents(1);
    for (let i = 0; i < 25; i++) await pcall(wc, "getAvailability", { watchId: `m${i}`, urls: [DIAL_URL] });
    await tick(20);
    assert.deepEqual(warnings, []);
    await manager.dispose();
  } finally {
    process.off("warning", onWarning);
  }
});
