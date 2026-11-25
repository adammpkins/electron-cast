#!/usr/bin/env node
// Records a real Cast v2 sender session as a scrubbed JSON trace, for the website's animated "protocol trace".
// It drives electron-cast's own CastClient through one session and taps the TLS socket for every frame in both
// directions: TLS connect, device auth, CONNECT receiver-0, GET_STATUS, LAUNCH of the Default Media Receiver,
// RECEIVER_STATUS, CONNECT to the app transport, media LOAD, MEDIA_STATUS updates, PING/PONG, PAUSE, PLAY, then
// media STOP, receiver STOP and CLOSE. The app it launched is always stopped at the end, also on SIGINT or error.
//
// Usage:
//   node tools/capture-trace.mjs --host <ip> [--port 8009] --out <file.json> [--app CC1AD845] [--media <url>]
//        [--content-type video/mp4] [--seconds 20] [--model "Chromecast Ultra"] [--allow-unscrubbed]
//   node tools/capture-trace.mjs --dry-run --out <file.json>     (in-process fake receiver, no network)
//   --seconds   playback budget: the time between LOAD being accepted and the final STOP (default 20; 4 in dry run).
//   --model     the device model recorded in the trace (the Cast protocol does not report it; take it from discovery).
//
// Output schema (version 1):
//   {
//     "version": 1,
//     "recordedAt": "YYYY-MM-DD",
//     "device": { "model": string, "name": "Living Room TV" },
//     "library": "electron-cast@<version>",
//     "frames": [ {
//       "t": number,                 // ms since the TLS connect was started
//       "dir": "out" | "in",         // out = sender to device, in = device to sender
//       "source": string,            // CastMessage.source_id
//       "destination": string,       // CastMessage.destination_id
//       "namespace": string,         // e.g. "urn:x-cast:com.google.cast.receiver"
//       "type": string,              // the JSON payload's "type" ("PING", "LAUNCH", ...), "binary", or "text"
//       "payload": object | string | { "binary": "<N bytes, certificate chain>" }
//     } ]
//   }
// Scrubbing (before anything is written): the device name becomes "Living Room TV"; session, transport, sender,
// device and cast ids, UUIDs and long hex tokens become stable fake ids (the same real value always maps to the same
// fake one); IPs become 192.0.2.x (IPv6: 2001:db8::x); MACs, serial numbers and user/account fields are removed;
// binary payloads (device auth) are reduced to their size. Anything that still looks like an IP, MAC, UUID or long
// hex token is listed and makes the tool exit 1 without writing, unless --allow-unscrubbed.
import { createSign, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import tls from "node:tls";
import { CastClient, NS } from "../src/client/index.ts";
import { decodeCastMessage, FrameDecoder, PayloadType } from "../src/protocol/index.ts";

const MEDIA_NS = "urn:x-cast:com.google.cast.media";
const DEFAULT_MEDIA = "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4";
const DEVICE_NAME = "Living Room TV";

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && i + 1 < args.length && !args[i + 1].startsWith("--") ? args[i + 1] : d;
};
const dryRun = flag("dry-run");
const host = opt("host", dryRun ? "127.0.0.1" : undefined);
const outFile = opt("out");
if (!outFile || (!host && !dryRun)) {
  console.error("usage: node tools/capture-trace.mjs --host <ip> [--port 8009] --out <file.json> [--app CC1AD845] [--media <url>] [--content-type video/mp4] [--seconds 20] [--model <name>] [--dry-run] [--allow-unscrubbed]");
  process.exit(2);
}
const appId = opt("app", "CC1AD845");
const mediaUrl = opt("media", DEFAULT_MEDIA);
const contentType = opt("content-type", "video/mp4");
const seconds = Number(opt("seconds", dryRun ? "4" : "20"));
if (!(seconds > 0)) {
  console.error("--seconds must be a positive number");
  process.exit(2);
}
const model = opt("model", dryRun ? "Fake Receiver" : "Chromecast");
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const budgetMs = seconds * 1000;
const heartbeatMs = Math.max(300, Math.min(3000, Math.floor(budgetMs / 4)));

// ---- recording -------------------------------------------------------------------------------------------------

const raw = [];
let t0 = 0;
let recording = true;

function record(dir, msg) {
  if (!recording) return;
  const t = Math.round(performance.now() - t0);
  let type;
  let payload;
  if (msg.payloadType === PayloadType.BINARY) {
    type = "binary";
    const n = (msg.payloadBinary ?? Buffer.alloc(0)).length;
    const what = msg.namespace === NS.DEVICE_AUTH ? (dir === "in" ? ", certificate chain" : ", auth challenge") : "";
    payload = { binary: `${n} bytes${what}` };
  } else {
    const text = msg.payloadUtf8 ?? "";
    try {
      payload = JSON.parse(text);
      type = typeof payload?.type === "string" ? payload.type : "json";
    } catch {
      payload = text;
      type = "text";
    }
  }
  raw.push({ t, dir, source: msg.sourceId, destination: msg.destinationId, namespace: msg.namespace, type, payload });
}

// The client creates its socket inside connect(), so the tap goes on tls.connect, which the library calls through
// the shared module object. Frames are decoded again here with the library's own codec.
const realConnect = tls.connect;
tls.connect = function (...a) {
  const socket = realConnect.apply(this, a);
  if (!recording) return socket;
  t0 = performance.now();
  const outDecoder = new FrameDecoder();
  const inDecoder = new FrameDecoder();
  const realWrite = socket.write;
  socket.write = function (chunk, ...rest) {
    try {
      for (const body of outDecoder.push(Buffer.from(chunk))) record("out", decodeCastMessage(body));
    } catch {}
    return realWrite.call(this, chunk, ...rest);
  };
  socket.on("data", (chunk) => {
    try {
      for (const body of inDecoder.push(chunk)) record("in", decodeCastMessage(body));
    } catch {}
  });
  return socket;
};

// ---- scrubbing -------------------------------------------------------------------------------------------------

const RE_UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const RE_MAC = /\b(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}\b/gi;
const RE_IPV4 = /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g;
const RE_IPV6 = /\b(?:[0-9a-f]{1,4}:){3,7}[0-9a-f]{1,4}\b(?:%[\w.]+)?|\b(?:[0-9a-f]{1,4}:){1,6}:[0-9a-f]{0,4}\b(?:%[\w.]+)?/gi;
const RE_HEX = /\b[0-9a-f]{16,}\b/gi;
const looksHex = (s) => /[a-f]/i.test(s) && /\d/.test(s);
const DROP_KEYS = /^(user|userid|user_id|username|account|accountid|email|credentials|credentialstype|token|authtoken|accesstoken|macaddress|mac|mac_address|serial|serialnumber|serial_number)$/i;
const NAME_KEYS = /^(friendlyname|friendly_name|devicename|device_name)$/i;
const ID_KEYS = /^(deviceid|device_id|castid|cast_id|udn)$/i;
const KEEP_IDS = new Set(["receiver-0", "sender-0", "*"]);

function scrubTrace(frames, { hostValues, senderId }) {
  const fakes = new Map(); // real value -> fake
  const counters = {};
  const fake = (kind, value) => {
    const key = `${kind}:${value.toLowerCase()}`;
    let f = fakes.get(key);
    if (f === undefined) {
      counters[kind] = (counters[kind] ?? 0) + 1;
      f = `${kind}-${String(counters[kind]).padStart(4, "0")}`;
      fakes.set(key, f);
    }
    return f;
  };
  const ipFake = (value, v6) => {
    const key = `ip:${value.toLowerCase()}`;
    let f = fakes.get(key);
    if (f === undefined) {
      counters.ip = (counters.ip ?? 0) + 1;
      f = v6 ? `2001:db8::${counters.ip}` : `192.0.2.${counters.ip}`;
      fakes.set(key, f);
    }
    return f;
  };

  // Pass 1: learn the ids that must map consistently, so they are also replaced inside longer strings.
  const secrets = new Map(); // real -> kind
  const learn = (v, key) => {
    if (typeof v === "string") {
      if (v.length >= 3 && !KEEP_IDS.has(v)) {
        if (/^sessionid$/i.test(key)) secrets.set(v, "session");
        else if (/^transportid$/i.test(key)) secrets.set(v, "transport");
        else if (/^senderid$/i.test(key)) secrets.set(v, "sender");
        else if (ID_KEYS.test(key)) secrets.set(v, "device");
      }
    } else if (Array.isArray(v)) v.forEach((x) => learn(x, key));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) learn(x, k);
  };
  secrets.set(senderId, "sender");
  for (const f of frames) learn(f.payload, "");
  for (const f of frames) {
    for (const id of [f.source, f.destination]) {
      if (!KEEP_IDS.has(id) && !secrets.has(id) && !hostValues.includes(id)) secrets.set(id, "transport");
    }
  }
  const ordered = [...secrets.entries()].sort((a, b) => b[0].length - a[0].length);

  const str = (s) => {
    for (const [real, kind] of ordered) if (s.includes(real)) s = s.split(real).join(fake(kind, real));
    s = s.replace(RE_UUID, (m) => fake("id", m));
    s = s.replace(RE_MAC, "<removed>");
    s = s.replace(RE_IPV4, (m) => ipFake(m, false));
    s = s.replace(RE_IPV6, (m) => (/^2001:db8:/i.test(m) ? m : ipFake(m, true)));
    s = s.replace(RE_HEX, (m) => (looksHex(m) ? fake("id", m) : m));
    return s;
  };
  const walk = (v, key) => {
    if (typeof v === "string") {
      if (NAME_KEYS.test(key)) return DEVICE_NAME;
      if (ID_KEYS.test(key) && !KEEP_IDS.has(v)) return fake("device", v);
      return str(v);
    }
    if (Array.isArray(v)) return v.map((x) => walk(x, key));
    if (v && typeof v === "object") {
      const out = {};
      for (const [k, x] of Object.entries(v)) {
        if (DROP_KEYS.test(k)) continue;
        out[str(k)] = walk(x, k);
      }
      return out;
    }
    return v;
  };
  return frames.map((f) => ({
    t: f.t,
    dir: f.dir,
    source: KEEP_IDS.has(f.source) ? f.source : str(f.source),
    destination: KEEP_IDS.has(f.destination) ? f.destination : str(f.destination),
    namespace: f.namespace,
    type: f.type === "binary" || f.type === "text" ? f.type : str(f.type),
    payload: walk(f.payload, ""),
  }));
}

function findLeaks(frames, extraNeedles) {
  const hits = [];
  const strings = (v, path, fn) => {
    if (typeof v === "string") fn(v, path);
    else if (Array.isArray(v)) v.forEach((x, i) => strings(x, `${path}[${i}]`, fn));
    else if (v && typeof v === "object")
      for (const [k, x] of Object.entries(v)) {
        fn(k, `${path}.${k} (key)`);
        strings(x, `${path}.${k}`, fn);
      }
  };
  frames.forEach((f, i) => {
    strings(f, `frames[${i}]`, (s, path) => {
      const test = (name, re, ok) => {
        for (const m of s.match(re) ?? []) if (!ok?.(m)) hits.push(`${name} ${JSON.stringify(m)} at ${path}`);
      };
      test("IPv4", RE_IPV4, (m) => m.startsWith("192.0.2."));
      test("IPv6", RE_IPV6, (m) => /^2001:db8:/i.test(m));
      test("MAC", RE_MAC);
      test("UUID", RE_UUID);
      test("hex token", RE_HEX, (m) => !looksHex(m));
      for (const n of extraNeedles) if (n && s.includes(n)) hits.push(`literal ${JSON.stringify(n)} at ${path}`);
    });
  });
  return hits;
}

// ---- the session -----------------------------------------------------------------------------------------------

const sleepers = new Set();
let aborted = false;
const sleep = (ms) =>
  new Promise((res) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      sleepers.delete(done);
      res();
    }
    sleepers.add(done);
  });
const checkAbort = () => {
  if (aborted) throw new Error("interrupted");
};
process.on("SIGINT", () => {
  aborted = true;
  for (const wake of [...sleepers]) wake();
});

async function startFake() {
  const { FakeReceiver, NS_HEARTBEAT } = await import("../test/client/fake-receiver.ts");
  const pki = await import("../test/client/pki.ts");
  const { encodeAuthResponse, HashAlgorithm } = await import("../src/protocol/device-auth.ts");
  const DAY = 86400000;
  const NOW = Date.now();
  const long = { notBefore: NOW - 3 * 365 * DAY, notAfter: NOW + 3 * 365 * DAY };
  const [rootKey, interKey, deviceKey, tlsKey, crlRootKey, crlSignerKey] = Array.from({ length: 6 }, () => pki.newKey());
  const rootDer = pki.makeCert({ subject: "Test Root", key: rootKey, ...long, extensions: [pki.EXT.basicConstraints(true), pki.EXT.keyUsage(5)] });
  const interDer = pki.makeCert({ subject: "Test Intermediate", issuer: "Test Root", key: interKey, signer: rootKey, ...long, extensions: [pki.EXT.basicConstraints(true, 0), pki.EXT.keyUsage(5)] });
  const deviceDer = pki.makeCert({ subject: "device-1", issuer: "Test Intermediate", key: deviceKey, signer: interKey, notBefore: NOW - DAY, notAfter: NOW + 100 * DAY, extensions: [pki.EXT.keyUsage(0)] });
  const crlRootDer = pki.makeCert({ subject: "Test CRL Root", key: crlRootKey, ...long, extensions: [pki.EXT.basicConstraints(true), pki.EXT.keyUsage(5)] });
  const crlSignerDer = pki.makeCert({ subject: "Test CRL Signer", issuer: "Test CRL Root", key: crlSignerKey, signer: crlRootKey, notBefore: Date.UTC(2020, 0, 1), notAfter: NOW + 3 * 365 * DAY, extensions: [pki.EXT.basicConstraints(false), pki.EXT.keyUsage(0)] });
  const tlsDer = pki.makeCert({ subject: "tls-device", key: tlsKey, notBefore: NOW - 3600_000, notAfter: NOW + 2 * DAY });
  const deviceAuth = {
    roots: [rootDer],
    crlRoots: [crlRootDer],
    fallbackCrl: pki.makeCrlBundle({ signerCert: crlSignerDer, signerKey: crlSignerKey, notBeforeSeconds: Math.floor((NOW - DAY) / 1000), notAfterSeconds: Math.floor((NOW + 7 * DAY) / 1000) }),
    fallbackCrlBuildTime: NOW,
  };
  const fake = new FakeReceiver({ key: tlsKey.privateKey.export({ type: "pkcs8", format: "pem" }), cert: pki.toPem(tlsDer) });
  const media = { state: "IDLE", base: 0, since: 0, contentId: "", contentType: "" };
  const position = () => (media.state === "PLAYING" ? media.base + (Date.now() - media.since) / 1000 : media.base);
  const setState = (state) => {
    media.base = position();
    media.state = state;
    media.since = Date.now();
  };
  const mediaStatus = (requestId) => ({
    type: "MEDIA_STATUS",
    requestId,
    status: [
      {
        mediaSessionId: 1,
        playbackRate: 1,
        playerState: media.state,
        currentTime: Math.round(position() * 1000) / 1000,
        supportedMediaCommands: 274447,
        volume: { level: 1, muted: false },
        currentItemId: 1,
        media: { contentId: media.contentId, streamType: "BUFFERED", contentType: media.contentType, duration: 596.474195 },
        ...(media.state === "IDLE" ? { idleReason: "CANCELLED" } : {}),
      },
    ],
  });
  const port = await fake.listen();
  const challengeNonce = (msg) => {
    const bin = msg.payloadBinary;
    const inner = bin.subarray(2, 2 + bin[1]);
    return inner.subarray(2, 2 + inner[1]);
  };
  let pingTimer = null;
  fake.onMessage = (msg) => {
    const type = msg.json?.type;
    const requestId = msg.json?.requestId;
    if (msg.namespace === NS.DEVICE_AUTH) {
      const nonce = challengeNonce(msg);
      const signature = createSign("sha256").update(Buffer.concat([nonce, tlsDer])).sign(deviceKey.privateKey);
      const payload = encodeAuthResponse({ signature, clientAuthCertificate: deviceDer, intermediateCertificates: [interDer], senderNonce: nonce, hashAlgorithm: HashAlgorithm.SHA256 });
      fake.send({ namespace: NS.DEVICE_AUTH, sourceId: "receiver-0", destinationId: msg.sourceId, payloadType: PayloadType.BINARY, payloadBinary: payload });
      return true;
    }
    if (msg.namespace === NS.CONNECTION && type === "CONNECT" && msg.destinationId === "receiver-0" && pingTimer === null) {
      pingTimer = setInterval(() => fake.sendJson(NS_HEARTBEAT, "receiver-0", "*", { type: "PING" }), heartbeatMs + 137);
      pingTimer.unref();
    }
    if (msg.namespace === NS.RECEIVER && type === "LAUNCH") {
      fake.apps = [
        {
          appId: msg.json.appId,
          displayName: "Default Media Receiver",
          sessionId: randomUUID(),
          transportId: `web-${10 + Math.floor(Math.random() * 80)}`,
          statusText: "Ready To Cast",
          namespaces: [{ name: MEDIA_NS }, { name: "urn:x-cast:com.google.cast.tp.connection" }, { name: "urn:x-cast:com.google.cast.tp.heartbeat" }],
          isIdleScreen: false,
          universalAppId: msg.json.appId,
        },
      ];
      const status = fake.status(requestId);
      fake.sendJson(NS.RECEIVER, "receiver-0", msg.sourceId, { ...status, status: { ...status.status, isActiveInput: true, userEligible: false } });
      return true;
    }
    if (msg.namespace === MEDIA_NS) {
      const app = fake.apps[0];
      const reply = (payload) => fake.sendJson(MEDIA_NS, app.transportId, msg.sourceId, payload);
      if (type === "LOAD") {
        media.contentId = msg.json.media.contentId;
        media.contentType = msg.json.media.contentType;
        media.base = 0;
        setState("BUFFERING");
        reply(mediaStatus(requestId));
        setTimeout(() => {
          setState("PLAYING");
          reply(mediaStatus(0));
        }, 300).unref();
      } else if (type === "PAUSE") {
        setState("PAUSED");
        reply(mediaStatus(requestId));
      } else if (type === "PLAY") {
        setState("PLAYING");
        reply(mediaStatus(requestId));
      } else if (type === "GET_STATUS") {
        reply(mediaStatus(requestId));
      } else if (type === "STOP") {
        setState("IDLE");
        reply(mediaStatus(requestId));
      } else reply({ type: "INVALID_REQUEST", requestId, reason: "INVALID_COMMAND" });
      return true;
    }
    return false;
  };
  return { port, deviceAuth, close: () => fake.close() };
}

function sessionRunner(client) {
  let mediaSessionId;
  client.on("message", (m) => {
    if (m.namespace !== MEDIA_NS || typeof m.data !== "string") return;
    try {
      const id = JSON.parse(m.data).status?.[0]?.mediaSessionId;
      if (typeof id === "number") mediaSessionId = id;
    } catch {}
  });
  const state = { session: undefined, mediaStarted: false };
  const mediaRequest = (payload) =>
    client.request(MEDIA_NS, state.session.transportId, { ...payload, sessionId: state.session.sessionId }, { timeoutMs: 20000 });
  return {
    state,
    async run() {
      await client.connect();
      console.log(`connected${client.deviceAuth ? ` (device auth: ${client.deviceAuth.policy})` : ""}`);
      checkAbort();
      await client.getStatus();
      checkAbort();
      state.session = await client.launch(appId);
      console.log(`launched ${state.session.displayName ?? appId}`);
      client.connectTransport(state.session.transportId);
      checkAbort();
      state.mediaStarted = true;
      const loaded = await mediaRequest({
        type: "LOAD",
        autoplay: true,
        currentTime: 0,
        media: { contentId: mediaUrl, streamType: "BUFFERED", contentType },
      });
      mediaSessionId ??= loaded.status?.[0]?.mediaSessionId;
      console.log("media loaded");
      const slice = budgetMs / 20;
      await sleep(slice * 2); // buffering, then the PLAYING update
      checkAbort();
      await mediaRequest({ type: "GET_STATUS", mediaSessionId });
      await sleep(slice * 3);
      checkAbort();
      await mediaRequest({ type: "GET_STATUS", mediaSessionId });
      await sleep(slice * 2);
      checkAbort();
      await mediaRequest({ type: "PAUSE", mediaSessionId });
      await sleep(slice * 4);
      checkAbort();
      await mediaRequest({ type: "PLAY", mediaSessionId });
      await sleep(slice * 6);
      checkAbort();
      await mediaRequest({ type: "GET_STATUS", mediaSessionId });
    },
    async stopAll() {
      if (!client.connected || !state.session) return;
      if (state.mediaStarted && mediaSessionId !== undefined) {
        try {
          await client.request(MEDIA_NS, state.session.transportId, { type: "STOP", mediaSessionId, sessionId: state.session.sessionId }, { timeoutMs: 5000 });
        } catch {}
      }
      try {
        await client.stop(state.session.sessionId);
      } catch (err) {
        console.error(`STOP failed: ${err?.message ?? err}`);
      }
    },
  };
}

// Last resort when the first connection died with an app running: reconnect (unrecorded) and stop what we launched.
async function stopViaNewConnection(options, sessionId) {
  recording = false;
  const c = new CastClient({ ...options, senderId: undefined });
  try {
    await c.connect();
    const status = await c.getStatus();
    for (const a of status.applications) if (a.sessionId === sessionId) await c.stop(sessionId);
  } finally {
    c.close();
  }
}

async function main() {
  let fakeServer;
  let options;
  if (dryRun && !flag("host")) {
    fakeServer = await startFake();
    options = { host: "127.0.0.1", port: fakeServer.port, deviceAuth: fakeServer.deviceAuth, authTimeoutMs: 3000 };
  } else {
    options = { host, port: Number(opt("port", "8009")), connectTimeoutMs: 10000 };
  }
  options = { ...options, heartbeatIntervalMs: heartbeatMs, heartbeatTimeoutMs: Math.max(10000, heartbeatMs * 3), requestTimeoutMs: 10000, launchTimeoutMs: 30000 };
  const client = new CastClient(options);
  const s = sessionRunner(client);
  let failure;
  try {
    await s.run();
  } catch (err) {
    failure = err;
    console.error(`session ended early: ${err?.message ?? err}`);
  }
  try {
    const wasConnected = client.connected;
    await s.stopAll();
    if (s.state.session && !wasConnected) {
      try {
        await stopViaNewConnection(options, s.state.session.sessionId);
      } catch (e) {
        console.error(`could not confirm the app was stopped: ${e?.message ?? e}`);
      }
    }
  } finally {
    client.close();
    await sleep(150); // let CLOSE and the device's last frames land
    await fakeServer?.close();
  }

  const frames = scrubTrace(raw, { hostValues: [options.host], senderId: client.senderId });
  const leaks = findLeaks(frames, [options.host]);
  const trace = {
    version: 1,
    recordedAt: new Date().toISOString().slice(0, 10),
    device: { model, name: DEVICE_NAME },
    library: `electron-cast@${pkg.version}`,
    frames,
  };
  if (leaks.length > 0) {
    console.error(`WARNING: ${leaks.length} value(s) still look unscrubbed:`);
    for (const l of leaks.slice(0, 30)) console.error(`  ${l}`);
    if (!flag("allow-unscrubbed")) {
      console.error("not writing the trace; fix the scrubber or pass --allow-unscrubbed");
      return 1;
    }
  }
  const outPath = resolve(outFile);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(trace, null, 2) + "\n");
  console.log(`wrote ${frames.length} frames to ${outPath}`);
  return failure ? (aborted ? 130 : 1) : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
