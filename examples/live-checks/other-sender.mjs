// A second sender, as a phone would be: its own sender id, its own connection, no Electron. It launches the Default Media Receiver
// on ONE named device, loads MDN's CC0 flower.mp4 and keeps the connection open. It prints one JSON object per line on stdout;
// it reads commands on stdin: `stop` stops the app (the other sender "ends the cast"), `quit` stops it if still running and exits.
//   node other-sender.mjs --sink "<device name>" [--secs 80]
// It never sets the volume, refuses to start unless the device shows no app, and quits within --secs whatever happens.
import { createInterface } from "node:readline";
import { CastClient, CastDiscovery } from "../../dist/index.js";

const args = process.argv.slice(2);
const value = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const SINK = value("sink", "");
const secs = Number(value("secs", "80"));
const APP_ID = "CC1AD845";
const VIDEO = "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4";
const NS_MEDIA = "urn:x-cast:com.google.cast.media";
if (SINK === "" || !(secs > 0 && secs <= 90)) { console.error("pass --sink <device name> and --secs 1 to 90"); process.exit(2); }
const say = (o) => console.log(JSON.stringify({ at: Date.now(), ...o }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const discovery = new CastDiscovery();
let client = null, session = null, done = false;
const finish = async (code, why) => {
  if (done) return; done = true;
  say({ ev: "ending", why });
  try { if (client?.connected && session) await client.stop(session.sessionId); } catch (e) { say({ ev: "stop-error", message: String(e?.message ?? e) }); }
  try { client?.close(); } catch { /* closing */ }
  try { discovery.stop(); } catch { /* stopping */ }
  process.exit(code);
};
setTimeout(() => finish(1, `time cap ${secs}s`), secs * 1000).unref?.();

await discovery.start();
let device;
for (let i = 0; i < 40 && !device; i++) { device = discovery.devices().find((d) => d.name === SINK); if (!device) await sleep(500); }
discovery.stop();
if (!device) { say({ ev: "error", message: `no device ${SINK}` }); process.exit(2); }

client = new CastClient({ host: device.addresses[0] ?? device.host, port: device.port, senderId: `sender-phone-${Math.random().toString(16).slice(2, 8)}` });
client.on("close", (e) => { say({ ev: "closed", message: e ? String(e.message) : null }); if (!done) finish(1, "connection lost"); });
client.on("receiverStatus", (s) => say({ ev: "receiver-status", apps: s.applications.map((a) => ({ appId: a.appId, sessionId: a.sessionId, statusText: a.statusText, idle: a.isIdleScreen === true })), volume: s.volume }));
let mediaState = null;
client.on("message", (m) => {
  if (m.namespace !== NS_MEDIA || typeof m.data !== "string") return;
  const j = JSON.parse(m.data);
  if (j.type !== "MEDIA_STATUS") return;
  const st = j.status?.[0]?.playerState ?? null;
  if (st !== mediaState) { mediaState = st; say({ ev: "media", playerState: st }); }
});
await client.connect();
say({ ev: "connected", senderId: client.senderId, device: device.name });

const status = await client.getStatus();
const busy = status.applications.filter((a) => a.isIdleScreen !== true);
if (busy.length > 0) { say({ ev: "error", message: `${SINK} is busy: ${busy.map((a) => a.appId).join(",")}` }); client.close(); process.exit(2); }

session = await client.launch(APP_ID);
say({ ev: "launched", appId: session.appId, sessionId: session.sessionId, transportId: session.transportId, displayName: session.displayName, statusText: session.statusText ?? "" });
client.connectTransport(session.transportId);
client.send(NS_MEDIA, session.transportId, { type: "LOAD", requestId: 1, autoplay: true, currentTime: 0, media: { contentId: VIDEO, contentType: "video/mp4", streamType: "BUFFERED" } });
say({ ev: "load-sent" });

createInterface({ input: process.stdin }).on("line", async (line) => {
  const cmd = line.trim();
  if (cmd === "stop") {
    try { const s = await client.stop(session.sessionId); session = null; say({ ev: "stopped", apps: s.applications.map((a) => a.appId) }); } catch (e) { say({ ev: "stop-error", message: String(e?.message ?? e) }); }
  } else if (cmd === "quit") finish(0, "quit");
}).on("close", () => finish(0, "stdin closed"));
