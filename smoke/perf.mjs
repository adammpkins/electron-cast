// Not part of `npm run smoke`: mirrors a 1920x1080 hue loop with a sweeping bar to the fake receiver for a while and lets
// the sender's own stage logging (latency stages, router bursts, feedback) print, to see what a heavy capture costs.
//   electron smoke/perf.mjs [--codec vp8|vp9|h264] [--secs 20] [--width 1920] [--height 1080]
// No real device is involved.
import { app, BrowserWindow, MessageChannelMain, ipcMain, utilityProcess, webContents } from "electron";
import { EventEmitter } from "node:events";
import { createCastManager } from "electron-cast/main";
// test/mirroring/fake-receiver.ts, bundled by build-preloads.mjs (run `npm run smoke` once, or `node smoke/build-preloads.mjs`).
import { FakeReceiver } from "./.out/fake-receiver.mjs";

const args = process.argv.slice(2);
const value = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const codec = value("codec", "vp8");
// Software codecs only unless H.264 is asked for: Chrome offers a hardware encoder first, which would win otherwise.
if (codec !== "h264") for (const c of ["h264", "vp8", "vp9"]) app.commandLine.appendSwitch(`cast-streaming-force-disable-hardware-${c}`);
const secs = Number(value("secs", "20"));
const width = Number(value("width", "1920"));
const height = Number(value("height", "1080"));
const noise = args.includes("--noise");
// The live harness shows a 960x540 window on screen; --visible and --window WxH reproduce that.
const visible = args.includes("--visible");
const [winW, winH] = value("window", `${width}x${height}`).split("x").map(Number);

const PAGE = `<!doctype html><meta charset=utf-8><body style="margin:0;overflow:hidden"><canvas id=c width=${width} height=${height} style="width:100vw;height:100vh"></canvas><script>
  const c = document.getElementById("c"), g = c.getContext("2d");
  let n = 0;
  (function draw() { n++; g.fillStyle = "hsl(" + (n * 2 % 360) + ",60%,40%)"; g.fillRect(0, 0, ${width}, ${height});
    ${noise ? `for (let i = 0; i < 600; i++) { g.fillStyle = "rgb(" + (Math.random() * 255 | 0) + "," + (Math.random() * 255 | 0) + "," + (Math.random() * 255 | 0) + ")"; g.fillRect(Math.random() * ${width}, Math.random() * ${height}, 200, 120); }` : ""}
    const x = ((performance.now() % 2000) / 2000) * (${width} - 80);
    g.fillStyle = "#fff"; g.fillRect(x, 700, 80, 120);
    g.font = "96px sans-serif"; g.fillText("frame " + n + "  " + Math.round(performance.now()) + " ms", 120, 300); requestAnimationFrame(draw); })();
  const ctx = new AudioContext(); const osc = ctx.createOscillator(); osc.connect(ctx.destination); osc.start(); ctx.resume().catch(() => {});
</script>`;

const TV = { id: "dev-perf", name: "Perf TV", model: "Fake", host: "127.0.0.1", addresses: ["127.0.0.1"], port: 8009, capabilities: 5, isGroup: false, statusText: "", instanceName: "perf", txt: {} };

async function main() {
await app.whenReady();
const receiver = await FakeReceiver.create({ verifyBody: false, videoPreference: codec === "h264" ? ["h264", "vp8"] : [codec] });
const client = new (class extends EventEmitter {
  senderId = "sender-perf";
  lastSource = "";
  connected = false;
  async connect() { this.connected = true; }
  async getStatus() { return { applications: [], volume: { level: 1, muted: false } }; }
  async setVolume() { return { applications: [], volume: { level: 1, muted: false } }; }
  close() {}
  send(namespace, _dest, payload) { this.lastSource = this.senderId; setImmediate(() => receiver.onControlMessage(namespace, payload)); }
  async launch(appId) { return { appId, displayName: "Streaming", sessionId: "s", transportId: "t", namespaces: [] }; }
  async stop() { return { applications: [], volume: {} }; }
  connectTransport() {}
  closeTransport() {}
})();
receiver.sendControl = (json) => setImmediate(() => client.emit("message", { namespace: "urn:x-cast:com.google.cast.webrtc", sourceId: "t", destinationId: client.lastSource, data: json }));
const discovery = Object.assign(new EventEmitter(), { devices: () => [{ ...TV }], async start() {}, stop() {} });
const cast = createCastManager({
  ipcMain, discovery, createClient: () => client, selectDevice: async () => null, presentation: false, channel: "electron-cast-perf", sinks: { openDelayMaxMs: 0, reportDelayMs: 0, allowAllIps: true },
  mirroring: {
    electron: { BrowserWindow, utilityProcess, MessageChannelMain, webContents, app },
    extraVideoCodecs: codec === "vp9" ? ["vp9"] : [],
    log: (l, m) => console.log(`perf[${codec}]: ${l}: ${m}`),
  },
});
await cast.start();
await cast.settled();
cast.registerMediaSinksObserver({ onSinksUpdated() {} }, { castMode: "tab_mirror", withAudio: false });
const page = new BrowserWindow({ width: winW, height: winH, useContentSize: true, show: false, webPreferences: { backgroundThrottling: false } });
await page.loadURL(`data:text/html;base64,${Buffer.from(PAGE).toString("base64")}`);
const route = await cast.startCasting(TV.id, { castMode: "tab_mirror", webContentsId: page.webContents.id });
if (visible) page.showInactive();
await new Promise((r) => setTimeout(r, 4000));
const f0 = receiver.stats.videoFrames, k0 = receiver.stats.videoKeyFrames;
await new Promise((r) => setTimeout(r, secs * 1000));
const s = receiver.stats;
console.log(`PERFSENT frames=${s.videoFrames - f0} key=${s.videoKeyFrames - k0} fps=${((s.videoFrames - f0) / secs).toFixed(2)} codec=${receiver.selectedVideoCodec}`);
console.log(`perf[${codec}]: receiver got ${s.videoFrames} video frames (${s.videoKeyFrames} key), ${Math.round((s.videoBytes * 8) / secs / 1000)} kbps over ${secs} s`);
await cast.terminateRoute(route.id);
page.destroy();
await cast.dispose();
receiver.close();
app.exit(0);
}
main().catch((e) => { console.error("perf: FAIL", e); app.exit(1); });
