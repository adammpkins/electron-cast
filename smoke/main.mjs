// Smoke test: electron-cast running in a real Electron, with only the network faked (see fakes.mjs).
// Exit code 0 on success, 1 with a "smoke: FAIL" line on any failure or after TIMEOUT_MS.
import { app, BrowserWindow, ipcMain, protocol } from "electron";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
// The built package entry through its own name, so the exports map and dist/ are what gets tested.
import { createCastManager } from "electron-cast/main";
import { FakeClient, FakeDiscovery, TV } from "./fakes.mjs";
import { runMirroringScenario } from "./mirroring.mjs";

const TIMEOUT_MS = 60_000;
const SCHEME = "smoke";
const PAGE_ORIGIN = `${SCHEME}://app`;
const APP_ID = "233637DE";
const CAST_URL = `https://google.com/cast#__castAppId__=${APP_ID}/__castClientId__=smoke-client`;
const here = (name) => fileURLToPath(new URL(name, import.meta.url));

function fail(err) {
  console.error(`smoke: FAIL ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  app.exit(1);
}
const timer = setTimeout(() => fail(new Error(`timed out after ${TIMEOUT_MS / 1000} s`)), TIMEOUT_MS);
process.on("uncaughtException", fail);
process.on("unhandledRejection", fail);

// A file:// page has an opaque origin ("null"); a standard, secure custom scheme gives the page a real one.
protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true } }]);

// Closing the first window must not quit the app before the second scenario runs
app.on("window-all-closed", () => {});

const pass = (name) => console.log(`smoke: ok   ${name}`);

/** What the page's code runs as: an async function body, evaluated in the page's main world. */
async function runInPage(win, body, userGesture = true) {
  // userGesture = true: the page sees transient user activation, which both modes require for a cast to start
  const json = await win.webContents.executeJavaScript(
    `(async () => { try { return JSON.stringify({ value: await (async () => { ${body} })() }); }` +
      ` catch (e) { return JSON.stringify({ error: String(e && e.stack || e) }); } })()`,
    userGesture,
  );
  const result = JSON.parse(json);
  if (result.error !== undefined) throw new Error(`page code failed: ${result.error}`);
  return result.value;
}

const PRESENTATION_PAGE = `
  const waitFor = async (what, check) => {
    for (let i = 0; i < 200; i++) {
      if (check()) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("page: timed out waiting for " + what);
  };
  const out = {};
  out.hasNavigatorPresentation = typeof navigator.presentation === "object" && navigator.presentation !== null;
  // the browser's own PresentationRequest is native code; the stand-in is a script class
  out.standIn = typeof PresentationRequest === "function"
    && !/\\[native code\\]/.test(Function.prototype.toString.call(PresentationRequest))
    && typeof PresentationConnection === "function";
  const request = new PresentationRequest([${JSON.stringify(CAST_URL)}]);
  out.available = (await request.getAvailability()).value;
  // start() is called in the same task as the gesture the harness supplied
  const connection = await request.start();
  const messages = [];
  connection.addEventListener("message", (e) => messages.push(JSON.parse(e.data)));
  await waitFor("new_session", () => messages.some((m) => m.type === "new_session"));
  out.messageTypes = messages.map((m) => m.type);
  out.newSessionAppId = messages.find((m) => m.type === "new_session").message.appId;
  out.stateBeforeTerminate = connection.state;
  let terminated = false;
  connection.addEventListener("terminate", () => { terminated = true; });
  connection.terminate();
  await waitFor("terminate", () => terminated);
  out.stateAfterTerminate = connection.state;
  return out;
`;

// Run without a gesture: both the page-side stand-in and, bypassing it, the bridge itself must be refused
const NO_GESTURE_PAGE = `
  const out = { activeAtStart: navigator.userActivation.isActive };
  const url = ${JSON.stringify(CAST_URL)};
  try {
    await new PresentationRequest([url]).start();
    out.standIn = "resolved";
  } catch (e) { out.standIn = e.name + ": " + e.message; }
  // What a hostile page would do: lie about userActivation in its own world, skip the stand-in and call the bridge
  // with a claimed gesture. The preload reads the real flag in its isolated world, which the page cannot touch.
  Object.defineProperty(Navigator.prototype, "userActivation", { get: () => ({ isActive: true, hasBeenActive: true }), configurable: true });
  out.forgedActive = navigator.userActivation.isActive;
  const raw = await window.__electronCastPresentationBridge.call("start", { connectionId: "forged", urls: [url], hasGesture: true });
  out.bridge = raw;
  return out;
`;

const CHROMECAST_PAGE = `
  const cast = chrome.cast;
  const out = { hasChromeCast: typeof cast === "object" && cast !== null, hasPresentationBridge: "__electronCastPresentationBridge" in window };
  const fromError = (e) => new Error(e && e.code ? e.code + ": " + e.description : String(e));
  const availability = [];
  const config = new cast.ApiConfig(new cast.SessionRequest(${JSON.stringify(APP_ID)}), () => {}, (a) => availability.push(a));
  await new Promise((resolve, reject) => cast.initialize(config, resolve, (e) => reject(fromError(e))));
  out.initialized = true;
  out.availability = availability;
  const session = await new Promise((resolve, reject) => cast.requestSession(resolve, (e) => reject(fromError(e))));
  out.appId = session.appId;
  out.receiver = session.receiver && session.receiver.friendlyName;
  out.sessionStatus = session.status;
  await new Promise((resolve, reject) => session.stop(resolve, (e) => reject(fromError(e))));
  return out;
`;

async function main() {
  await app.whenReady();
  const html = await readFile(here("page.html"));
  protocol.handle(SCHEME, () => new Response(html, { headers: { "content-type": "text/html" } }));

  const clients = [];
  const requests = [];
  const cast = createCastManager({
    ipcMain,
    discovery: new FakeDiscovery(),
    createClient: (device) => {
      const client = new FakeClient(device);
      clients.push(client);
      return client;
    },
    allowOrigin: (origin) => origin === PAGE_ORIGIN,
    // The picker: records what the page asked for and picks the one fake device
    selectDevice: async (devices, request) => {
      requests.push(request);
      return devices.find((d) => d.id === TV.id) ?? null;
    },
  });
  await cast.start();

  const preloadReports = new Map();
  ipcMain.on("smoke:preload", (event, report) => preloadReports.set(event.sender.id, report));

  const openPage = async (mode) => {
    const win = new BrowserWindow({
      width: 400,
      height: 300,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, preload: here(`.out/preload-${mode}.cjs`) },
    });
    // Electron reports a preload that throws here and the page loads on without it
    win.webContents.on("preload-error", (_e, path, error) => fail(new Error(`preload ${path} threw: ${error?.stack ?? error}`)));
    win.webContents.on("render-process-gone", (_e, details) => fail(new Error(`renderer gone: ${details.reason}`)));
    await win.loadURL(`${PAGE_ORIGIN}/index.html`);
    const report = preloadReports.get(win.webContents.id);
    assert.ok(report, `the ${mode} preload never reported in`);
    assert.equal(report.mode, mode);
    assert.equal(report.sandboxed, true, "the preload did not run sandboxed");
    return win;
  };

  // 1. default (presentation) mode
  {
    const win = await openPage("presentation");
    pass("sandboxed preload ran without throwing (presentation)");
    // Before the gesture-bearing run: neither route may reach the picker without transient activation
    const refused = await runInPage(win, NO_GESTURE_PAGE, false);
    assert.equal(refused.activeAtStart, false, "the page unexpectedly had user activation");
    assert.equal(refused.forgedActive, true, "the page could not forge its own navigator.userActivation");
    assert.equal(refused.standIn, "InvalidAccessError: PresentationRequest::start() requires user gesture.");
    assert.equal(refused.bridge.ok, false, "a bridge start() without a gesture was accepted");
    assert.equal(refused.bridge.code, "AbortError");
    assert.equal(refused.bridge.description, "PresentationRequest::start() requires user gesture.");
    assert.equal(requests.length, 0, "start() without a gesture reached selectDevice");
    pass("start() without a gesture is refused (stand-in, and the bridge called directly with a forged flag)");
    const out = await runInPage(win, PRESENTATION_PAGE);
    assert.equal(out.hasNavigatorPresentation, true, "navigator.presentation is missing");
    assert.equal(out.standIn, true, "PresentationRequest was not replaced by the stand-in");
    pass("page sees the Presentation API stand-in");
    assert.equal(out.available, true, "getAvailability() did not resolve true for the fake device");
    pass("getAvailability() resolves true for the fake device");
    assert.equal(requests.length, 1, "start() did not reach selectDevice exactly once");
    assert.equal(requests[0].appId, APP_ID);
    assert.equal(requests[0].origin, PAGE_ORIGIN);
    pass("start() with a user gesture reached selectDevice");
    assert.equal(clients.length, 1);
    assert.ok(clients[0].calls.includes(`launch ${APP_ID}`), `the fake client was not asked to launch: ${clients[0].calls}`);
    assert.ok(out.messageTypes.includes("new_session"), `no new_session envelope: ${out.messageTypes}`);
    assert.equal(out.newSessionAppId, APP_ID);
    assert.equal(out.stateBeforeTerminate, "connected");
    pass("fake client launched; the page's PresentationConnection received new_session");
    assert.equal(out.stateAfterTerminate, "terminated");
    assert.ok(clients[0].calls.some((c) => c.startsWith("stop ")), `terminate() did not stop the session: ${clients[0].calls}`);
    pass("terminate() stopped the session");
    win.destroy();
  }

  // 2. mode: "chromecast"
  {
    const win = await openPage("chromecast");
    pass("sandboxed preload ran without throwing (chromecast)");
    const out = await runInPage(win, CHROMECAST_PAGE);
    assert.equal(out.hasChromeCast, true, "chrome.cast is missing");
    assert.equal(out.hasPresentationBridge, false, "chromecast mode must not install the presentation bridge");
    assert.equal(out.initialized, true);
    pass("chrome.cast exists and initialize() succeeded");
    assert.equal(out.appId, APP_ID);
    assert.equal(out.receiver, TV.name);
    assert.equal(requests.length, 2, "requestSession() did not reach selectDevice");
    assert.equal(clients.length, 2, "requestSession() did not create a client");
    assert.ok(clients[1].calls.includes(`launch ${APP_ID}`));
    pass("requestSession() with a user gesture resolved a session from the fake client");
    win.destroy();
  }

  // 3. tab mirroring against the fake receiver
  await runMirroringScenario({ pass, fail });
  await runMirroringScenario({ pass, fail, mode: "desktop" });

  await cast.dispose();
  clearTimeout(timer);
  console.log("smoke: PASS");
  app.exit(0);
}

main().catch(fail);
