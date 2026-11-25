#!/usr/bin/env node
// SDK canary: checks that Google's Presentation-API Cast sender SDK ("clank") still speaks the router-message
// envelope the way electron-cast's translator expects (src/electron/presentation-envelope.ts and
// presentation-handler.ts). Google can change that SDK per Chrome major without an electron-cast release.
//
// The downloaded JavaScript is only ever searched as text. It is never evaluated.
//
// Usage: node tools/sdk-canary.mjs [--majors 158,159] [--electron 45|none] [--no-channels]
//                                  [--baseline path] [--update-baseline [major]] [--report path]
// Exit codes: 0 compatible (warnings allowed), 1 incompatible, 2 could not run the check.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const LOADER_URL = "https://www.gstatic.com/cv/js/sender/v1/cast_sender.js";
const CLANK = "https://www.gstatic.com/eureka/clank";
const VERSIONS = (channel) =>
  `https://versionhistory.googleapis.com/v1/chrome/platforms/win/channels/${channel}/versions?pageSize=1&orderBy=version%20desc`;
const ELECTRON_INDEX = "https://electronjs.org/headers/index.json";
const DEFAULT_BASELINE = fileURLToPath(new URL("./sdk-canary-baseline.json", import.meta.url));

/**
 * What electron-cast depends on. Keep in step with src/electron/presentation-envelope.ts (ENVELOPE_TYPES,
 * MEDIA_REQUEST_TYPES, parsePresentationUrl, mediaCommands) and presentation-handler.ts (dispatch and
 * onServiceEvent).
 */
const DEPENDS = {
  // Types the SDK sends and electron-cast acts on (client_connect is accepted and ignored).
  sentHandled: ["client_connect", "app_message", "v2_message", "leave_session", "custom_dial_launch", "dial_app_info"],
  // Types electron-cast sends and the SDK must handle (error carries no underscore, so it is checked as a literal).
  receivedHandled: ["new_session", "update_session", "receiver_action", "app_message", "v2_message", "custom_dial_launch"],
  // Types electron-cast sends that the SDK is not expected to read; informational only.
  receivedOptional: ["remove_session", "disconnect_session"],
  // Envelope and message field names. Presence of the identifier in the SDK is all that can be checked from text.
  fields: [
    "type", "message", "sequenceNumber", "timeoutMillis", "clientId",
    "sessionId", "namespaceName",
    "receiver", "action", "label", "friendlyName", "capabilities", "volume", "isActiveInput", "displayStatus", "receiverType",
    "appId", "displayName", "appImages", "transportId", "namespaces", "statusText", "senderApps",
    "status", "supportedMediaCommands", "level", "muted",
    // DIAL: the custom_dial_launch / dial_app_info bodies (src/dial/route-provider.ts).
    "appState", "extraData", "doLaunch", "launchParameter",
  ],
  // v2_message subtypes: handled locally, forwarded as media requests, and the reply the SDK reads.
  v2Local: ["SET_VOLUME", "STOP"],
  v2Media: ["LOAD", "QUEUE_LOAD", "MEDIA_GET_STATUS", "PLAY", "PAUSE", "SEEK", "STOP_MEDIA", "MEDIA_SET_VOLUME",
    "EDIT_TRACKS_INFO", "QUEUE_INSERT", "QUEUE_UPDATE", "QUEUE_REMOVE", "QUEUE_REORDER"],
  v2Reply: ["MEDIA_STATUS"],
  // Command names electron-cast derives from supportedMediaCommands bits. queue_next/queue_prev are optional.
  mediaCommands: ["pause", "seek", "stream_volume", "stream_mute"],
  mediaCommandsOptional: ["queue_next", "queue_prev"],
  // Presentation URL: the `cast:<appId>?...` form and the parameters electron-cast reads from it.
  urlForm: "cast:",
  urlParams: ["capabilities", "clientId", "autoJoinPolicy", "defaultActionPolicy", "launchTimeout", "dialPostData"],
  // The DIAL source the SDK adds next to the Cast one when the page passes a dialRequest.
  dialUrlForm: "cast-dial:",
  // Presentation ids and members the SDK uses against the stand-in Presentation API.
  presentationIds: ["cast-session_", "auto-join"],
  presentationMembers: ["PresentationRequest", "defaultRequest", "reconnect", "onconnect", "onclose", "onterminate", "onmessage"],
  // The SDK numbers requests itself (default -1) and echoes sequenceNumber back; clientId is its own per-load id.
  sequenceNumberKey: "sequenceNumber",
};

const SNAKE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/;

/** Collects what a clank cast_sender.js says about the envelope, using text search only. */
export function extract(src) {
  const sent = new Set();
  for (const m of src.matchAll(/new [\w$.]+\("([a-z][a-z0-9_]*)"\s*,/g)) if (SNAKE.test(m[1])) sent.add(m[1]);
  const received = new Set();
  for (const m of src.matchAll(/case "([a-z][a-z0-9_]*)":/g)) if (SNAKE.test(m[1])) received.add(m[1]);
  const urlParams = new Set();
  for (const m of src.matchAll(/\.set\("([A-Za-z]+)"/g)) urlParams.add(m[1]);
  const urlForms = new Set();
  for (const m of src.matchAll(/"(cast-session_|cast-dial:|cast:|https:\/\/google\.com\/cast#)/g)) urlForms.add(m[1]);
  return { sent: [...sent].sort(), received: [...received].sort(), urlParams: [...urlParams].sort(), urlForms: [...urlForms].sort() };
}

const has = {
  literal: (src, s) => src.includes(`"${s}"`) || src.includes(`'${s}'`),
  word: (src, s) => new RegExp(`(?<![\\w$])${s.replace(/[$]/g, "\\$")}(?![\\w$])`).test(src),
  text: (src, s) => src.includes(s),
};

/** Checks one SDK source against DEPENDS and the baseline. Returns failures, warnings and notes. */
export function check(src, baseline) {
  const failures = [];
  const warnings = [];
  const notes = [];
  const found = extract(src);
  const miss = (what, list, test) => {
    const gone = list.filter((s) => !test(src, s));
    if (gone.length > 0) failures.push(`${what} missing from the SDK: ${gone.join(", ")}`);
  };

  for (const t of DEPENDS.sentHandled) {
    if (!found.sent.includes(t)) failures.push(`the SDK no longer sends envelope type "${t}" (electron-cast handles it)`);
  }
  for (const t of DEPENDS.receivedHandled) {
    if (!has.literal(src, t)) failures.push(`the SDK no longer mentions envelope type "${t}" (electron-cast sends it)`);
  }
  if (!has.literal(src, "error")) failures.push('the SDK no longer mentions envelope type "error"');
  for (const t of DEPENDS.receivedHandled.filter((t) => t !== "app_message" && t !== "v2_message")) {
    if (has.literal(src, t) && !found.received.includes(t)) failures.push(`the SDK no longer has a switch case for "${t}"`);
  }
  miss("envelope/message field(s)", DEPENDS.fields, has.word);
  miss("v2_message type(s) electron-cast handles locally", DEPENDS.v2Local, has.literal);
  miss("v2_message media request type(s)", DEPENDS.v2Media, has.literal);
  miss("v2_message reply type(s)", DEPENDS.v2Reply, has.literal);
  miss("media command name(s)", DEPENDS.mediaCommands, has.literal);
  miss("presentation id prefix(es)", DEPENDS.presentationIds, has.literal);
  miss("Presentation API member(s)", DEPENDS.presentationMembers, has.word);
  if (!has.literal(src, DEPENDS.urlForm)) failures.push(`the SDK no longer builds "${DEPENDS.urlForm}<appId>" presentation URLs`);
  if (!has.literal(src, DEPENDS.dialUrlForm)) failures.push(`the SDK no longer builds "${DEPENDS.dialUrlForm}<app>" DIAL presentation URLs`);
  for (const p of DEPENDS.urlParams) {
    if (!found.urlParams.includes(p)) failures.push(`the SDK no longer sets the "${p}" presentation URL parameter`);
  }
  if (!has.word(src, DEPENDS.sequenceNumberKey)) failures.push("the SDK no longer uses sequenceNumber");

  const handled = new Set([...DEPENDS.sentHandled, ...DEPENDS.receivedHandled]);
  const known = (kind) => new Set([...(baseline[kind] ?? []), ...(baseline.knownUnhandled?.[kind] ?? [])]);
  for (const kind of ["sent", "received"]) {
    const base = known(kind);
    const fresh = found[kind].filter((t) => !base.has(t) && !handled.has(t));
    if (fresh.length > 0) {
      warnings.push(`new envelope type(s) ${kind === "sent" ? "the SDK sends" : "the SDK handles"} that electron-cast does not handle: ${fresh.join(", ")}`);
    }
  }
  const baseParams = new Set([...(baseline.urlParams ?? []), ...(baseline.knownUnhandled?.urlParams ?? [])]);
  const freshParams = found.urlParams.filter((p) => !baseParams.has(p) && !DEPENDS.urlParams.includes(p));
  if (freshParams.length > 0) warnings.push(`new .set("...") parameter name(s): ${freshParams.join(", ")} (may be new presentation URL parameters)`);
  const baseForms = new Set([...(baseline.urlForms ?? []), ...(baseline.knownUnhandled?.urlForms ?? [])]);
  const freshForms = found.urlForms.filter((f) => !baseForms.has(f) && f !== DEPENDS.urlForm && f !== DEPENDS.dialUrlForm);
  if (freshForms.length > 0) warnings.push(`new presentation URL form(s) electron-cast does not parse: ${freshForms.join(", ")}`);

  const baseAll = new Set([...(baseline.sent ?? []), ...(baseline.received ?? []), ...Object.values(baseline.knownUnhandled ?? {}).flat()]);
  const gone = [...baseAll].filter((t) => SNAKE.test(t) && ![...found.sent, ...found.received].includes(t) && !handled.has(t));
  if (gone.length > 0) notes.push(`baseline types no longer seen (electron-cast does not depend on them): ${gone.join(", ")}`);
  for (const t of DEPENDS.receivedOptional) if (!has.literal(src, t)) notes.push(`"${t}" is sent by electron-cast but the SDK never reads it (it relies on the connection closing)`);
  for (const t of DEPENDS.mediaCommandsOptional) if (!has.literal(src, t)) notes.push(`media command "${t}" is not used by the SDK`);
  return { failures, warnings, notes, found };
}

/** Checks the loader still sends Presentation-API browsers to the clank path. */
export function checkLoader(src) {
  const failures = [];
  if (!/www\.gstatic\.com\/eureka\/clank\/"\s*\+\s*[\w$]+\s*\+\s*"\/cast_sender\.js"/.test(src)) {
    failures.push('the loader no longer builds ".../eureka/clank/<major>/cast_sender.js"');
  }
  if (!src.includes("www.gstatic.com/eureka/clank/cast_sender.js")) failures.push("the loader no longer lists the unversioned clank fallback");
  if (!src.includes("navigator.presentation")) failures.push("the loader no longer gates on navigator.presentation");
  if (!/Chrome\\?\/\(\[0-9\]\+\)/.test(src)) failures.push("the loader no longer reads the Chrome major from the user agent");
  if (!src.includes("cast_framework.js")) failures.push("the loader no longer loads cast_framework.js");
  return failures;
}

async function get(url, { allow404 = false } = {}) {
  let last;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000), redirect: "follow" });
      if (res.status === 404 && allow404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, attempt * 1000));
    }
  }
  throw new Error(`GET ${url} failed: ${last?.message ?? last}`);
}

async function chromeMajor(channel) {
  const body = JSON.parse(await get(VERSIONS(channel)));
  const v = body.versions?.[0]?.version;
  const major = Number.parseInt(v ?? "", 10);
  if (!Number.isInteger(major)) throw new Error(`unexpected versionhistory answer for ${channel}`);
  return { major, version: v };
}

async function electronChromiumMajor(electronMajor) {
  const list = JSON.parse(await get(ELECTRON_INDEX));
  const release = list.find((r) => r.version.startsWith(`${electronMajor}.`) && !r.version.includes("-"));
  if (!release) return null;
  return { major: Number.parseInt(release.chrome, 10), version: `${release.chrome} (Electron ${release.version})` };
}

/** What a Chrome <major> loader would load: <major>, then <major>-1, then the unversioned file. */
async function fetchFor(major) {
  const tried = [];
  for (const m of [major, major - 1]) {
    const url = `${CLANK}/${m}/cast_sender.js`;
    const src = await get(url, { allow404: true });
    if (src !== null && /chrome\.cast/.test(src)) return { url, served: m, src, tried };
    tried.push(src === null ? `${m} (404)` : `${m} (not an SDK)`);
  }
  return { url: null, served: null, src: null, tried };
}

function parseArgs(argv) {
  const o = { majors: [], electron: "45", channels: true, baseline: DEFAULT_BASELINE, update: null, report: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => argv[++i];
    if (a === "--majors") o.majors.push(...val().split(",").map((s) => Number.parseInt(s, 10)).filter(Number.isInteger));
    else if (a === "--electron") o.electron = val();
    else if (a === "--no-channels") o.channels = false;
    else if (a === "--baseline") o.baseline = val();
    else if (a === "--report") o.report = val();
    else if (a === "--update-baseline") o.update = argv[i + 1] && /^\d+$/.test(argv[i + 1]) ? Number(argv[++i]) : "stable";
    else if (a === "--help" || a === "-h") {
      console.log("Usage: node tools/sdk-canary.mjs [--majors 158,159] [--electron 45|none] [--no-channels] [--baseline file] [--update-baseline [major]] [--report file]");
      process.exit(0);
    } else throw new Error(`unknown argument ${a}`);
  }
  return o;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const targets = new Map(); // major -> labels
  const add = (major, label) => targets.set(major, [...(targets.get(major) ?? []), label]);
  const setup = [];
  for (const m of opts.majors) add(m, "requested");
  if (opts.channels) {
    for (const ch of ["stable", "beta", "dev"]) {
      const { major, version } = await chromeMajor(ch);
      add(major, ch);
      setup.push(`Chrome ${ch}: ${version}`);
    }
  }
  if (opts.electron !== "none") {
    const e = await electronChromiumMajor(opts.electron);
    if (e) {
      add(e.major, `Electron ${opts.electron}`);
      setup.push(`Electron ${opts.electron}: Chromium ${e.version}`);
    } else setup.push(`Electron ${opts.electron}: no stable release found (skipped)`);
  }
  if (targets.size === 0) throw new Error("no Chrome majors to check");

  const loaderSrc = await get(LOADER_URL);
  const loaderFailures = checkLoader(loaderSrc);

  if (opts.update !== null) {
    const major = opts.update === "stable" ? (await chromeMajor("stable")).major : opts.update;
    const r = await fetchFor(major);
    if (!r.src) throw new Error(`no SDK found for Chrome ${major}`);
    const found = extract(r.src);
    const prev = existsBaseline(opts.baseline);
    const out = {
      generatedFrom: { chromeMajor: major, servedMajor: r.served, sha256: sha256(r.src), date: new Date().toISOString().slice(0, 10) },
      sent: found.sent,
      received: found.received,
      urlParams: found.urlParams,
      urlForms: found.urlForms,
      knownUnhandled: prev?.knownUnhandled ?? { sent: [], received: [], urlForms: [] },
    };
    writeFileSync(opts.baseline, `${JSON.stringify(out, null, 2)}\n`);
    console.log(`Baseline written to ${opts.baseline} from clank ${r.served}. Review knownUnhandled by hand.`);
    return 0;
  }

  const baseline = JSON.parse(readFileSync(opts.baseline, "utf8"));
  const results = [];
  for (const major of [...targets.keys()].sort((a, b) => b - a)) {
    const r = await fetchFor(major);
    const labels = targets.get(major).join(", ");
    if (r.src === null) {
      results.push({ major, labels, failures: [`no clank SDK is published for ${r.tried.join(" or ")}`], warnings: [], notes: [], served: null });
      continue;
    }
    const c = check(r.src, baseline);
    const notes = [...c.notes];
    if (r.served !== major) notes.unshift(`clank ${major} is not published yet; a Chrome ${major} loader falls back to clank ${r.served}`);
    results.push({ major, labels, ...c, notes, served: r.served, bytes: r.src.length, sha: sha256(r.src).slice(0, 12) });
  }
  // The unversioned file is the loader's last resort; a failure there is only a warning.
  const unv = await get(`${CLANK}/cast_sender.js`, { allow404: true });
  const unversioned = unv ? check(unv, baseline) : null;

  const report = render({ setup, loaderFailures, results, unversioned, baseline });
  console.log(report.text);
  const md = report.markdown;
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${md}\n`);
  if (opts.report) writeFileSync(opts.report, `${md}\n`);
  const failed = loaderFailures.length > 0 || results.some((r) => r.failures.length > 0);
  return failed ? 1 : 0;
}

function existsBaseline(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function sha256(s) {
  return createHash("sha256").update(s).digest("hex");
}

function render({ setup, loaderFailures, results, unversioned, baseline }) {
  const t = [];
  const m = [];
  const failed = loaderFailures.length > 0 || results.some((r) => r.failures.length > 0);
  const warned = results.some((r) => r.warnings.length > 0);
  const headline = failed ? "FAIL: Google's Cast SDK no longer matches what electron-cast handles" : warned ? "PASS with warnings" : "PASS";
  t.push(`SDK canary: ${headline}`, `Baseline: clank ${baseline.generatedFrom?.servedMajor ?? "?"} (${baseline.generatedFrom?.date ?? "?"})`, ...setup.map((s) => `  ${s}`), "");
  m.push(`## SDK canary: ${headline}`, "", `Baseline: clank ${baseline.generatedFrom?.servedMajor ?? "?"} (${baseline.generatedFrom?.date ?? "?"})`, "", ...setup.map((s) => `- ${s}`), "");
  const section = (title, items, sym) => {
    for (const i of items) {
      t.push(`    ${sym} ${i}`);
      m.push(`  - ${sym} ${i}`);
    }
    void title;
  };
  t.push(`Loader: ${loaderFailures.length ? "FAIL" : "ok"}`);
  m.push(`- Loader (${LOADER_URL}): ${loaderFailures.length ? "**FAIL**" : "ok"}`);
  section("loader", loaderFailures, "FAIL");
  const common = results.length > 1 ? results[0].notes.filter((n) => results.every((r) => r.notes.includes(n))) : [];
  for (const r of results) {
    const state = r.failures.length ? "FAIL" : r.warnings.length ? "warn" : "ok";
    const served = r.served === null ? "none" : `clank ${r.served}, ${r.bytes} bytes, sha256 ${r.sha}`;
    t.push(`Chrome ${r.major} (${r.labels}): ${state} [${served}]`);
    m.push(`- Chrome ${r.major} (${r.labels}): **${state}** (${served})`);
    section("f", r.failures, "FAIL");
    section("w", r.warnings, "WARN");
    section("n", r.notes.filter((n) => !common.includes(n)), "note");
  }
  if (common.length > 0) {
    t.push("Notes that apply to every target:");
    m.push("- Notes that apply to every target:");
    section("c", common, "note");
  }
  if (unversioned) {
    t.push(`Unversioned clank/cast_sender.js (loader's last resort): ${unversioned.failures.length ? "differs (informational)" : "ok"}`);
    m.push(`- Unversioned \`clank/cast_sender.js\` (loader's last resort): ${unversioned.failures.length ? "differs (informational)" : "ok"}`);
    section("u", [...unversioned.failures.map((f) => `${f}`), ...unversioned.warnings], "warn");
  }
  return { text: t.join("\n"), markdown: m.join("\n") };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(`SDK canary could not run: ${e.message}`);
      process.exit(2);
    },
  );
}
