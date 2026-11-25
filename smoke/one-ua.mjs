// A presentation URL on a Cast device (Chrome's 1-UA mode) in a real Electron against the fake receiver
// (test/mirroring/fake-receiver.ts): a page starts a PresentationRequest for an ordinary URL, the library renders that
// URL in an offscreen tab, mirrors the tab to the receiver, and connects the page to the tab's
// navigator.presentation.receiver. No real Cast device is involved.
//
// Silent: no page here makes a sound, the offscreen tab is muted, and no window is shown.
import { app, BrowserWindow, MessageChannelMain, ipcMain, screen, utilityProcess, webContents } from "electron";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { createCastManager } from "electron-cast/main";
import { FakeReceiver } from "./.out/fake-receiver.mjs";

const RECEIVER_PAGE = `<!doctype html><meta charset=utf-8><title>receiver</title><body style="margin:0;background:#103">
<canvas id=c width=1280 height=720 style="width:100vw;height:100vh;display:block"></canvas><script>
  const c = document.getElementById("c"), g = c.getContext("2d");
  let n = 0, last = "(no message yet)";
  (function draw() { n++; g.fillStyle = "hsl(" + (n * 0.1 % 360) + ",60%,35%)"; g.fillRect(0, 0, 1280, 720);
    g.fillStyle = "#fff"; g.font = "64px sans-serif"; g.fillText("1-UA receiver, frame " + n, 60, 320); g.fillText(last, 60, 420); requestAnimationFrame(draw); })();
  window.seen = [];
  const hook = (conn) => {
    conn.onmessage = (e) => { last = String(e.data); window.seen.push(last); conn.send("echo:" + e.data + ":" + innerWidth + "x" + innerHeight); };
  };
  navigator.presentation.receiver.connectionList.then((list) => {
    list.connections.forEach(hook);
    list.onconnectionavailable = (e) => hook(e.connection);
  });
</script>`;
const CONTROLLER_PAGE = "<!doctype html><meta charset=utf-8><title>controller</title><body>controller";

const LOOPBACK_TV = {
  id: "dev-loopback", name: "Loopback TV", model: "Fake", host: "127.0.0.1", addresses: ["127.0.0.1"], port: 8009,
  capabilities: 5, isGroup: false, statusText: "", instanceName: "loopback", txt: {},
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function inPage(win, body) {
  const json = await win.webContents.executeJavaScript(
    `(async () => { try { return JSON.stringify({ value: await (async () => { ${body} })() }); } catch (e) { return JSON.stringify({ error: String(e && e.stack || e) }); } })()`,
    true,
  );
  const result = JSON.parse(json);
  if (result.error !== undefined) throw new Error(`page code failed: ${result.error}`);
  return result.value;
}

export async function runOneUaScenario({ pass, fail, engineModulePath }) {
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(req.url.startsWith("/receiver") ? RECEIVER_PAGE : CONTROLLER_PAGE);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  // http is a presentation URL only on localhost (IsValidPresentationUrl)
  const base = `http://localhost:${server.address().port}`;
  const receiverUrl = `${base}/receiver.html`;

  const receiver = await FakeReceiver.create({ verifyBody: false, videoPreference: ["h264", "vp8"] });
  const calls = [];
  const client = new (class extends EventEmitter {
    senderId = "sender-smoke1ua";
    lastSource = "";
    // the manager keeps one channel open to the device, which the session tracker and mirroring share
    connected = false;
    async connect() { this.connected = true; }
    async getStatus() { return { applications: [], volume: { level: 1, muted: false } }; }
    async setVolume() { return { applications: [], volume: { level: 1, muted: false } }; }
    async getAppAvailability(appIds) { calls.push(`availability ${appIds.join(",")}`); return Object.fromEntries(appIds.map((id) => [id, true])); }
    close() {}
    send(namespace, _destinationId, payload) {
      this.lastSource = this.senderId;
      setImmediate(() => receiver.onControlMessage(namespace, payload));
    }
    async launch(appId) {
      calls.push(`launch ${appId}`);
      return { appId, displayName: "Streaming", sessionId: "one-ua-session", transportId: "one-ua-transport", namespaces: [] };
    }
    async stop(sessionId) { calls.push(`stop ${sessionId}`); return { applications: [], volume: {} }; }
    connectTransport() {}
    closeTransport() {}
  })();
  receiver.sendControl = (json) =>
    setImmediate(() => client.emit("message", { namespace: "urn:x-cast:com.google.cast.webrtc", sourceId: "one-ua-transport", destinationId: client.lastSource, data: json }));

  const logs = [];
  const discovery = Object.assign(new EventEmitter(), { devices: () => [{ ...LOOPBACK_TV }], async start() {}, stop() {} });
  const cast = createCastManager({
    ipcMain, discovery, createClient: () => client, channel: "electron-cast",
    selectDevice: async (devices) => devices.find((d) => d.id === LOOPBACK_TV.id) ?? null,
    sinks: { openDelayMaxMs: 0, reportDelayMs: 0, allowAllIps: true },
    mirroring: {
      electron: { BrowserWindow, utilityProcess, MessageChannelMain, webContents, app, screen },
      engineModulePath,
      log: (l, m) => { logs.push(m); console.log(`smoke: [1-UA] mirroring ${l}: ${m}`); },
    },
  });
  await cast.start();
  await cast.settled();

  const page = new BrowserWindow({
    show: false,
    webPreferences: { preload: fileURLToPath(new URL(".out/preload-presentation.cjs", import.meta.url)), sandbox: true, contextIsolation: true },
  });
  page.webContents.setAudioMuted(true);
  page.webContents.on("render-process-gone", (_e, d) => fail(new Error(`page renderer gone: ${d.reason}`)));
  await page.loadURL(`${base}/controller.html`);
  const tabOf = () => webContents.getAllWebContents().find((wc) => wc.getURL().startsWith(receiverUrl));

  try {
    const available = await inPage(page, `
      const a = await new PresentationRequest([${JSON.stringify(receiverUrl)}]).getAvailability();
      for (let i = 0; i < 100 && !a.value; i++) await new Promise((r) => setTimeout(r, 50));
      return a.value;`);
    assert.equal(available, true, "an https URL is not available on the Cast sink");
    pass("[1-UA] getAvailability() is true for an ordinary presentation URL with a Cast sink that has the streaming app");

    const started = await inPage(page, `
      const conn = await new PresentationRequest([${JSON.stringify(receiverUrl)}]).start();
      window.conn = conn;
      window.got = [];
      window.states = [conn.state];
      conn.onmessage = (e) => window.got.push(e.data);
      conn.onconnect = () => window.states.push("connected");
      conn.onterminate = () => window.states.push("terminated");
      conn.onclose = () => window.states.push("closed");
      for (let i = 0; i < 400 && conn.state !== "connected"; i++) await new Promise((r) => setTimeout(r, 25));
      return { id: conn.id, url: conn.url, state: conn.state };`);
    assert.equal(started.state, "connected", "the connection to the offscreen tab's receiver never connected");
    assert.equal(started.url, receiverUrl);
    assert.ok(started.id.startsWith("mr_"), started.id);
    assert.ok(calls.includes("launch 0F5096E8"), `calls: ${calls}`);
    const [route] = cast.getRoutes();
    assert.equal(route.description, "Presenting (localhost)");
    assert.equal(route.mediaSource, receiverUrl);
    assert.deepEqual(route.members, [page.webContents.id]);
    pass(`[1-UA] start() made the route "${route.description}" (app 0F5096E8) and the connection connected`);

    const tab = tabOf();
    assert.ok(tab, "no offscreen tab is showing the receiver URL");
    const tabWindow = BrowserWindow.fromWebContents(tab);
    assert.equal(tabWindow.isVisible(), false, "the offscreen tab's window is visible");
    assert.equal(tab.isAudioMuted(), true, "the offscreen tab is not muted");
    const [w, h] = tabWindow.getContentSize();
    const display = screen.getPrimaryDisplay();
    console.log(`smoke: [1-UA] offscreen tab ${w}x${h} (primary display ${display.size.width}x${display.size.height} at scale ${display.scaleFactor})`);

    const echo = await inPage(page, `
      window.conn.send("ping");
      for (let i = 0; i < 200 && window.got.length === 0; i++) await new Promise((r) => setTimeout(r, 25));
      return window.got;`);
    assert.equal(echo.length, 1, "no answer from the receiver page");
    assert.ok(echo[0].startsWith("echo:ping:"), echo[0]);
    assert.equal(echo[0], `echo:ping:${w}x${h}`, "the page in the tab is not the size of the tab");
    assert.deepEqual(await tab.executeJavaScript("window.seen"), ["ping"]);
    pass(`[1-UA] a message went to the offscreen tab's receiver connection and its answer came back (${echo[0]})`);

    // The tab's session lets the mirroring host capture the tab; the page in it must not get the screen that way
    const own = await tab.executeJavaScript(
      `navigator.mediaDevices.getUserMedia({ video: { mandatory: { chromeMediaSource: "desktop" } } }).then((st) => { st.getTracks().forEach((t) => t.stop()); return "captured"; }, (e) => e.name)`,
      true,
    );
    assert.equal(own, "NotAllowedError", "the page in the offscreen tab could capture the screen");
    pass("[1-UA] the page in the offscreen tab is refused a screen capture of its own");

    const s = receiver.stats;
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && s.validVideoFrames < 30) await wait(100);
    await wait(1500);
    console.log(`smoke: [1-UA] video ${s.videoFrames} frames (${s.validVideoFrames} valid ${receiver.selectedVideoCodec}, ${s.videoKeyFrames} key, sizes ${[...s.videoSizes].join(" ")}), audio ${s.audioFrames} frames, invalid ${s.invalidFrames}`);
    assert.ok(s.validVideoFrames >= 30, `only ${s.validVideoFrames} valid video frames reached the receiver`);
    assert.equal(s.invalidFrames, 0);
    for (const size of s.videoSizes) {
      const [fw, fh] = size.split("x").map(Number);
      assert.ok(Math.abs(fw / fh - 16 / 9) < 0.02, `a ${size} frame is not 16:9`);
    }
    assert.equal(tab.isBeingCaptured(), true);
    assert.equal(tabWindow.isVisible(), false, "capturing showed the offscreen tab's window");
    pass(`[1-UA] the fake receiver decrypted and validated frames captured from the hidden offscreen tab, sizes ${[...s.videoSizes].join(" ")}`);

    // terminate() from the page: the route, the session and the tab all end
    await inPage(page, `
      window.conn.terminate();
      for (let i = 0; i < 400 && window.conn.state !== "terminated"; i++) await new Promise((r) => setTimeout(r, 25));
      return window.conn.state;`).then((state) => assert.equal(state, "terminated"));
    for (let i = 0; i < 100 && (cast.getRoutes().length > 0 || tabOf() !== undefined); i++) await wait(50);
    assert.deepEqual(cast.getRoutes(), []);
    assert.equal(tabOf(), undefined, "the offscreen tab outlived its route");
    assert.ok(calls.includes("stop one-ua-session"), `calls: ${calls}`);
    pass("[1-UA] terminate() from the page ended the route, stopped the receiver app and destroyed the offscreen tab");

    // The page in the tab closing itself (OffscreenTab::CloseContents) ends the presentation too
    const again = await inPage(page, `
      const conn = await new PresentationRequest([${JSON.stringify(receiverUrl)}]).start();
      window.conn2 = conn;
      for (let i = 0; i < 400 && conn.state !== "connected"; i++) await new Promise((r) => setTimeout(r, 25));
      return conn.state;`);
    assert.equal(again, "connected");
    const tab2 = tabOf();
    assert.ok(tab2);
    tab2.executeJavaScript("window.close()", true).catch(() => {});
    const ended = await inPage(page, `
      for (let i = 0; i < 400 && window.conn2.state !== "terminated"; i++) await new Promise((r) => setTimeout(r, 25));
      return window.conn2.state;`);
    assert.equal(ended, "terminated");
    for (let i = 0; i < 100 && cast.getRoutes().length > 0; i++) await wait(50);
    assert.deepEqual(cast.getRoutes(), []);
    pass("[1-UA] window.close() in the offscreen tab ended the route and terminated the page's connection");
  } finally {
    page.destroy();
    await cast.dispose();
    receiver.close();
    server.close();
  }
}
