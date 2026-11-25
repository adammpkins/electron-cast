// Tab and desktop mirroring in a real Electron against the fake receiver (test/mirroring/fake-receiver.ts) over localhost
// UDP: capture (getUserMedia) -> WebCodecs video + Opus in the hidden agent window -> engine utility process -> encrypt ->
// RTP -> the fake receiver, which decrypts and validates each frame. No real Cast device is involved.
//
// The video codec is whatever Chrome's rules give this machine: H.264 when WebCodecs has a hardware H.264 encoder here
// (`prefer-hardware`), VP8 in software otherwise. The `hardware: "off"` variant uses Chrome's own
// `--cast-streaming-force-disable-hardware-*` switches, appended to `app.commandLine` as an app would, to get the
// software path on such a machine; `hardware: "vp9"` also makes the receiver ask for VP9, which is then software VP9.
import { app, BrowserWindow, MessageChannelMain, desktopCapturer, ipcMain, utilityProcess, webContents } from "electron";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createCastManager } from "electron-cast/main";
import { FakeReceiver } from "../test/mirroring/fake-receiver.ts";

const mirrorPage = (width, height) => `<!doctype html><meta charset=utf-8><body style="margin:0"><canvas id=c width=${width} height=${height}></canvas><script>
  const c = document.getElementById("c"), g = c.getContext("2d");
  let n = 0;
  (function draw() { n++; g.fillStyle = "hsl(" + (n * 0.1 % 360) + ",70%,50%)"; g.fillRect(0, 0, ${width}, ${height});
    g.fillStyle = "#fff"; g.font = "48px sans-serif"; g.fillText("frame " + n, 40, ${Math.round(height / 2)}); requestAnimationFrame(draw); })();
  const ctx = new AudioContext(); const osc = ctx.createOscillator(); osc.connect(ctx.destination); osc.start();
  ctx.resume().catch(() => {});
</script>`;
const MIRROR_PAGE = mirrorPage(640, 360);

const LOOPBACK_TV = {
  id: "dev-loopback", name: "Loopback TV", model: "Fake", host: "127.0.0.1", addresses: ["127.0.0.1"], port: 8009,
  capabilities: 5, isGroup: false, statusText: "", instanceName: "loopback", txt: {},
};

export async function runMirroringScenario({ pass, fail, engineModulePath, mode = "tab", hardware = "default", content = [640, 360] }) {
  // Every line says which scenario it belongs to, so a failure in a run of several is not ambiguous.
  const shape = content[0] * 9 === content[1] * 16 || mode === "desktop" ? "" : `, ${content[0]}x${content[1]} page`;
  const name = `${mode}${hardware === "off" ? ", software" : hardware === "vp9" ? ", software VP9" : ""}${shape}`;
  // Chrome's switches go on the app's own command line, which the mirroring host reads at each session.
  const switches = hardware === "default" ? [] : ["h264", "vp8", "vp9"].map((c) => `cast-streaming-force-disable-hardware-${c}`);
  for (const s of switches) app.commandLine.appendSwitch(s);
  try {
    await runScenario({ pass: (m) => pass(`[${name}] ${m}`), fail: (e) => fail(e), engineModulePath, mode, hardware, content, name });
  } catch (err) {
    if (err instanceof Error) err.message = `[${name}] ${err.message}`;
    throw err;
  } finally {
    for (const s of switches) app.commandLine.removeSwitch(s);
  }
}

async function runScenario({ pass, fail, engineModulePath, mode, hardware, content, name }) {
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
  // H.264 first: the receiver takes it when it is offered, which is when this machine has a hardware encoder.
  const receiver = await FakeReceiver.create({ verifyBody: false, videoPreference: hardware === "vp9" ? ["vp9"] : ["h264", "vp8"] });
  const calls = [];
  let encodersLine = "";
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
    mirroring: {
      electron: { BrowserWindow, utilityProcess, MessageChannelMain, desktopCapturer, webContents, app },
      engineModulePath,
      log: (l, m) => { if (m.startsWith("encoders:")) encodersLine = m; console.log(`smoke: [${name}] mirroring ${l}: ${m}`); },
    },
  });
  await cast.start();

  const sinks = [];
  const stopObserving = cast.registerMediaSinksObserver({ onSinksUpdated: (s) => sinks.push(s) }, { castMode: mode === "desktop" ? "desktop_mirror" : "tab_mirror", withAudio: mode === "desktop" });
  assert.equal(sinks[0]?.length, 1, "the loopback TV is not listed for tab mirroring");
  stopObserving();

  const page = new BrowserWindow({ width: content[0], height: content[1], useContentSize: true, show: false, webPreferences: { backgroundThrottling: false } });
  page.webContents.on("render-process-gone", (_e, d) => fail(new Error(`page renderer gone: ${d.reason}`)));
  await page.loadURL(`data:text/html;base64,${Buffer.from(mirrorPage(content[0], content[1])).toString("base64")}`);

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
  const codec = receiver.selectedVideoCodec;
  const label = codec === "h264" ? "H.264" : codec === "vp9" ? "VP9" : "VP8";
  // The probe line names what the machine's WebCodecs found: hardware [...], software [...].
  const hardwareFound = /hardware \[([^\]]*)\]/.exec(encodersLine)?.[1] ?? "";
  const expected = hardware === "vp9" ? "vp9" : hardware !== "off" && hardwareFound.split(", ").includes("h264") ? "h264" : "vp8";
  console.log(`smoke: [${name}] encoders found: ${encodersLine.replace(/^encoders: /, "")}; the receiver selected ${codec}`);
  console.log(`smoke: [${name}] mirroring video ${s.videoFrames} frames (${s.validVideoFrames} valid ${label}, ${s.videoKeyFrames} key, ${(s.videoFrames / seconds).toFixed(1)} fps, ${Math.round((s.videoBytes * 8) / seconds / 1000)} kbps, sizes ${[...s.videoSizes].join(" ")}), audio ${s.audioFrames} frames (${s.validAudioFrames} valid Opus, ${Math.round(s.audioBytes / Math.max(1, s.audioFrames))} B avg), invalid ${s.invalidFrames}`);
  assert.equal(codec, expected, `the encoders found (${encodersLine}) should give ${expected}`);
  if (hardware === "vp9") {
    // Software VP9 at 1080p30 on this machine: the receiver must get a steady stream, not a trickle.
    const fps = s.videoFrames / seconds;
    assert.ok(fps >= 20, `software VP9 delivered only ${fps.toFixed(1)} fps at ${[...s.videoSizes].join(" ")}`);
  }
  assert.ok(s.validVideoFrames >= 30, `only ${s.validVideoFrames} valid ${label} frames reached the receiver`);
  // Sender-side letterboxing (resolution_change_policy fixed_aspect_ratio, which a receiver that cannot scale gets): the
  // stream keeps the aspect ratio of the maximum, 16:9, whatever shape the page or screen is.
  // The fake receiver reads the picture size from VP8 and H.264 key frames only.
  if (codec !== "vp9") assert.ok(s.videoSizes.size > 0, "no key frame told its size");
  for (const size of s.videoSizes) {
    const [w, h] = size.split("x").map(Number);
    assert.ok(Math.abs(w / h - 16 / 9) < 0.02, `a ${size} frame is not 16:9`);
  }
  assert.ok(s.validAudioFrames >= 60, `only ${s.validAudioFrames} valid Opus frames reached the receiver`);
  assert.equal(s.invalidFrames, 0);
  // A key frame is asked for once at the start; more would be bitrate spikes. (libvpx VP9 cuts a key frame by itself at a
  // scene change, so the page changes colour slowly: it used to flip every frame and gave 5 key frames in 4 s.)
  assert.ok(s.videoKeyFrames >= 1 && s.videoKeyFrames <= 2, `${s.videoKeyFrames} key frames reached the receiver`);
  pass(`fake receiver decrypted and validated ${label} (${expected === "h264" ? "hardware" : "software"} encoder) and Opus frames from the captured ${mode}, picture sizes ${[...s.videoSizes].join(" ")}`);

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
