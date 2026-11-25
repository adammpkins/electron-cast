// Tab mirroring in a real Electron against the fake receiver (test/mirroring/fake-receiver.ts) over localhost UDP:
// capture (getUserMedia, tab) -> WebCodecs VP8 + Opus in the hidden agent window -> engine utility process ->
// encrypt -> RTP -> the fake receiver, which decrypts and validates each frame. No real Cast device is involved.
import { BrowserWindow, MessageChannelMain, desktopCapturer, ipcMain, utilityProcess, webContents } from "electron";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createCastManager } from "electron-cast/main";
import { FakeReceiver } from "../test/mirroring/fake-receiver.ts";

const MIRROR_PAGE = `<!doctype html><meta charset=utf-8><body style="margin:0"><canvas id=c width=640 height=360></canvas><script>
  const c = document.getElementById("c"), g = c.getContext("2d");
  let n = 0;
  (function draw() { n++; g.fillStyle = "hsl(" + (n * 3 % 360) + ",70%,50%)"; g.fillRect(0, 0, 640, 360);
    g.fillStyle = "#fff"; g.font = "48px sans-serif"; g.fillText("frame " + n, 40, 180); requestAnimationFrame(draw); })();
  const ctx = new AudioContext(); const osc = ctx.createOscillator(); osc.connect(ctx.destination); osc.start();
  ctx.resume().catch(() => {});
</script>`;

const LOOPBACK_TV = {
  id: "dev-loopback", name: "Loopback TV", model: "Fake", host: "127.0.0.1", addresses: ["127.0.0.1"], port: 8009,
  capabilities: 5, isGroup: false, statusText: "", instanceName: "loopback", txt: {},
};

export async function runMirroringScenario({ pass, fail, engineModulePath, mode = "tab" }) {
  // Every line says which scenario it belongs to, so a failure in a run of both is not ambiguous.
  try {
    await runScenario({ pass: (m) => pass(`[${mode}] ${m}`), fail: (e) => fail(e), engineModulePath, mode });
  } catch (err) {
    if (err instanceof Error) err.message = `[${mode}] ${err.message}`;
    throw err;
  }
}

async function runScenario({ pass, fail, engineModulePath, mode }) {
  let screen;
  if (mode === "desktop") {
    [screen] = await desktopCapturer.getSources({ types: ["screen"] });
    if (screen === undefined) { pass("desktop mirroring skipped: this machine has no screen to capture"); return; }
  }
  // A desktop capture is damage driven, so a still screen yields few frames; give it something that moves.
  let mover;
  if (mode === "desktop") {
    mover = new BrowserWindow({ width: 320, height: 200, x: 40, y: 40, show: false, alwaysOnTop: true, focusable: false, skipTaskbar: true, webPreferences: { backgroundThrottling: false } });
    await mover.loadURL(`data:text/html;base64,${Buffer.from(MIRROR_PAGE.replace("new AudioContext()", "{ resume() { return Promise.resolve(); }, createOscillator: () => ({ connect() {}, start() {} }), destination: null }")).toString("base64")}`);
    mover.showInactive();
  }
  const receiver = await FakeReceiver.create({ verifyBody: false });
  const calls = [];
  const client = new (class extends EventEmitter {
    senderId = "sender-smoke01";
    lastSource = "";
    async connect() { calls.push("connect"); }
    close() { calls.push("close"); }
    send(namespace, destinationId, payload) {
      calls.push(`send ${destinationId}`);
      this.lastSource = this.senderId;
      setImmediate(() => receiver.onControlMessage(namespace, payload));
    }
    async launch(appId) {
      calls.push(`launch ${appId}`);
      return { appId, displayName: "Streaming", sessionId: "mirror-session", transportId: "mirror-transport", namespaces: [] };
    }
    async stop(sessionId) { calls.push(`stop ${sessionId}`); return { applications: [], volume: {} }; }
    connectTransport(id) { calls.push(`connectTransport ${id}`); }
    closeTransport(id) { calls.push(`closeTransport ${id}`); }
  })();
  receiver.sendControl = (json) =>
    setImmediate(() => client.emit("message", { namespace: "urn:x-cast:com.google.cast.webrtc", sourceId: "mirror-transport", destinationId: client.lastSource, data: json }));

  const discovery = Object.assign(new EventEmitter(), { devices: () => [{ ...LOOPBACK_TV }], async start() {}, stop() {} });
  const cast = createCastManager({
    ipcMain, discovery, createClient: () => client, selectDevice: async () => null, presentation: false, channel: "electron-cast-mirroring-smoke",
    mirroring: { electron: { BrowserWindow, utilityProcess, MessageChannelMain, desktopCapturer, webContents }, engineModulePath, log: (l, m) => console.log(`smoke: [${mode}] mirroring ${l}: ${m}`) },
  });
  await cast.start();

  const sinks = [];
  const stopObserving = cast.registerMediaSinksObserver({ onSinksUpdated: (s) => sinks.push(s) }, { castMode: mode === "desktop" ? "desktop_mirror" : "tab_mirror", withAudio: mode === "desktop" });
  assert.equal(sinks[0]?.length, 1, "the loopback TV is not listed for tab mirroring");
  stopObserving();

  const page = new BrowserWindow({ width: 640, height: 360, show: false, webPreferences: { backgroundThrottling: false } });
  page.webContents.on("render-process-gone", (_e, d) => fail(new Error(`page renderer gone: ${d.reason}`)));
  await page.loadURL(`data:text/html;base64,${Buffer.from(MIRROR_PAGE).toString("base64")}`);

  const routesSeen = [];
  cast.registerMediaRoutesObserver({ onRoutesUpdated: (r) => routesSeen.push(r) });
  const route = await cast.startCasting(
    LOOPBACK_TV.id,
    mode === "desktop"
      ? { castMode: "desktop_mirror", desktopSourceId: screen.id, withAudio: true }
      : { castMode: "tab_mirror", webContentsId: page.webContents.id },
  );
  assert.equal(route.description, mode === "desktop" ? "Casting screen" : "Casting tab");
  assert.ok(calls.includes("launch 0F5096E8"), `launch calls: ${calls}`);
  pass(`${mode} mirroring route started (${route.description}, app 0F5096E8)`);

  const deadline = Date.now() + 15_000;
  const s = receiver.stats;
  while (Date.now() < deadline && !(s.validVideoFrames >= 30 && s.validAudioFrames >= 60)) await new Promise((r) => setTimeout(r, 100));
  await new Promise((r) => setTimeout(r, 3000));
  const seconds = ((s.lastFrameAt ?? 0) - (s.firstFrameAt ?? 0)) / 1000;
  console.log(`smoke: [${mode}] mirroring video ${s.videoFrames} frames (${s.validVideoFrames} valid VP8, ${s.videoKeyFrames} key, ${(s.videoFrames / seconds).toFixed(1)} fps, ${Math.round((s.videoBytes * 8) / seconds / 1000)} kbps), audio ${s.audioFrames} frames (${s.validAudioFrames} valid Opus, ${Math.round(s.audioBytes / Math.max(1, s.audioFrames))} B avg), invalid ${s.invalidFrames}`);
  assert.ok(s.validVideoFrames >= 30, `only ${s.validVideoFrames} valid VP8 frames reached the receiver`);
  assert.ok(s.validAudioFrames >= 60, `only ${s.validAudioFrames} valid Opus frames reached the receiver`);
  assert.equal(s.invalidFrames, 0);
  assert.ok(s.videoKeyFrames >= 1);
  pass(`fake receiver decrypted and validated VP8 and Opus frames from the captured ${mode}`);

  await cast.terminateRoute(route.id);
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(cast.getRoutes(), []);
  assert.ok(calls.includes("stop mirror-session"), `calls: ${calls}`);
  pass("terminateRoute stopped the capture, the engine and the receiver app");

  page.destroy();
  mover?.destroy();
  await cast.dispose();
  receiver.close();
}
