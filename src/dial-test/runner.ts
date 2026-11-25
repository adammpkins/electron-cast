// The DIAL device test: discovers DIAL devices with the library's own discovery, reads what they say about themselves,
// and, if the person at the keyboard agrees, opens and closes YouTube on one with the library's own launch and stop
// requests. It makes the same requests Chrome's Media Router makes and nothing else, apart from one TLS connection to
// the Cast port (opened and closed straight away, no Cast message is sent). It never needs Electron.
import os from "node:os";
import tls from "node:tls";
import { randomUUID } from "node:crypto";
import { listIPv4Interfaces, type NetworkInterfaceInfo } from "../discovery/cast-discovery.ts";
import {
  DialService, DialRouteProvider, createDialHttp, dialEnvelope, type DialHttp, type DialHttpOptions, type DialHttpResult, type DialRegistryOptions,
  type DialSink,
} from "../dial/index.ts";
import { isValidDeviceUrl, parseDeviceDescription, type DialAppInfoResult, type DialDeviceData } from "../dial/parse.ts";
import { parseXml, type XmlElement } from "../dial/xml.ts";
import { renderReport, type ReportData, type RequestRecord, type Step, type StepResult } from "./report.ts";
import { Scrubber } from "./scrub.ts";

export interface DialTestIo {
  /** Shows a line to the person running the test. */
  print(line: string): void;
  /** Asks a question; resolves null when there is no one to answer (the input ended). */
  ask(question: string): Promise<string | null>;
}

export interface DialTestOptions {
  libraryVersion: string;
  /** How long discovery runs (default 10 s). */
  discoverMs?: number;
  /** 1-based device to test; with several devices and none given, the first is used under `yes`, else the person is asked. */
  deviceIndex?: number;
  /** Answer the question about opening YouTube with yes and do not ask the others; for scripts. */
  yes?: boolean;
  /** False for a run that never opens anything (no question about it is asked). */
  launch?: boolean;
  /** How long YouTube stays open before the person is asked about it (default 6 s). */
  holdMs?: number;
  /** How long to give the TV to close YouTube before asking whether it did (default 1.5 s). */
  closeMs?: number;
  /** The Cast port to knock on (default 8009). */
  castPort?: number;
  /** Cancels the run: any app it opened is stopped first. */
  signal?: AbortSignal;
  /** For tests: where discovery looks, and how fast it goes. */
  registry?: DialRegistryOptions;
  httpOptions?: DialHttpOptions;
  settleMs?: number;
}

export interface DialTestResult {
  /** The scrubbed Markdown report. */
  report: string;
  interrupted: boolean;
  /** 0 normally, 1 when no device could be tested as asked, 130 when interrupted. */
  exitCode: number;
  /** The device's model name, for the issue title; empty when none was tested. */
  model: string;
}

/**
 * The Chrome version the test claims in the search's USER-AGENT and the Origin header when it does not run inside
 * Chrome or Electron: plain Node has no `process.versions.chrome`, and the library would then say 0.
 */
const EMULATED_CHROME = "142.0.0.0";
const APP = "YouTube";
const OTHER_APP = "Netflix";
const CLIENT_ID = "dial-test";
const PAGE_ORIGIN = "https://www.youtube.com";

class Interrupted extends Error {}

type Answer = { status: number; headers: Record<string, string>; body: string };

const wait = (ms: number, signal: AbortSignal): Promise<void> => new Promise<void>((resolve, reject) => {
  if (signal.aborted) {
    reject(new Interrupted());
    return;
  }
  const onAbort = (): void => {
    clearTimeout(timer);
    reject(new Interrupted());
  };
  const timer = setTimeout(() => {
    signal.removeEventListener("abort", onAbort);
    resolve();
  }, ms);
  signal.addEventListener("abort", onAbort, { once: true });
});

/** The promise's value, or `undefined` once `ms` have passed; the timer never outlives the call. */
function within<T>(promise: Promise<T>, ms: number, signal?: AbortSignal): Promise<T | undefined> {
  return new Promise<T | undefined>((resolve) => {
    const done = (value: T | undefined): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const onAbort = (): void => done(undefined);
    const timer = setTimeout(() => done(undefined), ms);
    signal?.addEventListener("abort", onAbort, { once: true });
    promise.then(done, () => done(undefined));
  });
}

/** The library's HTTP layer with a note of every request, and what the devices answered to the GETs. */
function recordingHttp(inner: DialHttp, records: RequestRecord[], answers: Map<string, Answer>): DialHttp {
  const note = async (method: string, url: string, call: () => Promise<DialHttpResult>): Promise<DialHttpResult> => {
    const start = performance.now();
    const result = await call();
    const ms = Math.round(performance.now() - start);
    records.push({
      method, url, ms,
      status: result.ok ? result.status : (result.status ?? null),
      ...(result.ok ? {} : { error: result.message }),
    });
    if (method === "GET" && result.ok) answers.set(url, { status: result.status, headers: result.headers, body: result.body });
    return result;
  };
  return {
    get: (url, setOrigin, signal) => note("GET", url, () => inner.get(url, setOrigin, signal)),
    post: (url, body, signal) => note("POST", url, () => inner.post(url, body, signal)),
    delete: (url, signal) => note("DELETE", url, () => inner.delete(url, signal)),
    abortAll: () => inner.abortAll?.(),
  };
}

/** One TLS connection to the Cast port, closed at once. DIAL-to-Cast promotion tries exactly this before it speaks Cast. */
function knockOnCastPort(host: string, port: number, signal: AbortSignal): Promise<{ ok: boolean; ms: number; detail: string }> {
  return new Promise((resolve) => {
    const start = performance.now();
    let done = false;
    const socket = tls.connect({ host, port, rejectUnauthorized: false });
    const finish = (ok: boolean, detail: string): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      socket.destroy();
      resolve({ ok, ms: Math.round(performance.now() - start), detail });
    };
    const timer = setTimeout(() => finish(false, "no answer in 5 s"), 5000);
    const onAbort = (): void => finish(false, "interrupted");
    signal.addEventListener("abort", onAbort, { once: true });
    socket.once("secureConnect", () => finish(true, `TLS handshake completed (${socket.getProtocol() ?? "TLS"})`));
    socket.once("error", (error: NodeJS.ErrnoException) => finish(false, error.code ?? error.message));
  });
}

/** The app-info document with the values under `additionalData` removed: they can name the person using the app. */
export function redactAppInfo(xml: string): string {
  const redactInner = (inner: string): string => inner
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "REDACTED")
    .replace(/>(\s*[^<\s][^<]*)</g, ">REDACTED<")
    .replace(/(\s[\w:.-]+)=("[^"]*"|'[^']*')/g, "$1=\"REDACTED\"");
  const out = xml.replace(
    /(<additionalData\b[^>]*>)([\s\S]*?)(<\/additionalData>)/gi,
    (_m, open: string, inner: string, close: string) => `${open}${redactInner(inner)}${close}`,
  );
  return out.length > 6000 ? `${out.slice(0, 6000)}\n<!-- cut -->` : out;
}

/** Elements anywhere in a description whose names say they identify the unit; their text is registered for scrubbing. */
function registerIdentifiers(element: XmlElement, scrubber: Scrubber): void {
  for (const child of element.children) {
    if (/serial|mac|uuid|udn|ssid|wifi|deviceid|friendly|address|hostname/i.test(child.name)) {
      if (/udn|uuid/i.test(child.name)) scrubber.uuid(child.text);
      else scrubber.secret(child.text, `<${child.name.toLowerCase()}>`);
    }
    registerIdentifiers(child, scrubber);
  }
}

function field(device: XmlElement | undefined, name: string): string {
  return device?.children.find((c) => c.name === name)?.text?.trim() ?? "";
}

function deviceElement(answer: Answer | undefined): XmlElement | undefined {
  return answer === undefined ? undefined : parseXml(answer.body)?.children.find((c) => c.name === "device");
}

/** The first three are always shown, the others only when the device gives them. */
const FIELDS: Array<[label: string, element: string]> = [
  ["Manufacturer", "manufacturer"], ["Model name", "modelName"], ["Model number", "modelNumber"],
  ["Model description", "modelDescription"], ["Device type", "deviceType"], ["Software version", "softwareVersion"],
  ["Firmware version", "firmwareVersion"], ["Hardware version", "hardwareVersion"],
];

interface Candidate {
  device: DialDeviceData;
  sink: DialSink | null;
  manufacturer: string;
  model: string;
  /** Why the library did not accept it, when it did not. */
  rejected: string;
  /** What the TLS knock on the Cast port found; null for a device that cannot be tested. */
  cast: { ok: boolean; ms: number; detail: string } | null;
}

const label = (c: { manufacturer: string; model: string }): string => [c.manufacturer, c.model].filter((s) => s !== "").join(" ") || "(unnamed device)";

function rejectionReason(device: DialDeviceData, answer: Answer | undefined, status: number | null): string {
  if (answer === undefined) return status === null ? "the description could not be fetched" : `the description request answered ${status}`;
  const header = (answer.headers["application-url"] ?? "").trim();
  if (header === "") return "the description has no Application-URL header";
  if (!isValidDeviceUrl(header, device.ipAddress)) return "the Application-URL header does not name the device's own address";
  const parsed = parseDeviceDescription(answer.body, header, device.ipAddress);
  return parsed.ok ? "not accepted" : `the description is not valid (${parsed.error})`;
}

const NO_DIAL_ONLY = "No DIAL-only TV found. This test is for TVs without built-in Chromecast.";
const CAST_NOTE = "This device accepts TLS on the Cast port, so it is a Cast device. electron-cast, like Chrome, shows it as a Cast device rather than a DIAL one"
  + " (CreateCastSinkFromDialSink). The YouTube launch test is meant for DIAL-only TVs.";

/**
 * What a failed app-info request means. Chrome treats every non-2xx answer as `kHttpError`
 * (`DialAppDiscoveryService::OnDialAppInfoFetchError`, dial_app_discovery_service.cc) and
 * `DialMediaSinkServiceImpl::GetSinkAppStatusFromResponse` (dial_media_sink_service_impl.cc) then marks the app unavailable
 * on that device, so a refusal is an answer, not a failure of the test.
 */
function appInfoProblem(result: DialAppInfoResult): { refused: boolean; text: string } {
  if (result.resultCode === "http_error" && result.httpErrorCode === 403) {
    return {
      refused: true,
      text: "GET 403: the device refused requests that carry Chrome's DIAL origin (Cast devices do this; Chrome treats the app as unavailable over DIAL and reaches them over Cast instead)",
    };
  }
  if (result.resultCode === "http_error") return { refused: false, text: `the device answered ${result.httpErrorCode ?? "with an error"}; Chrome treats the app as unavailable on it` };
  if (result.resultCode === "parsing_error") return { refused: false, text: "the answer is not a valid app info document" };
  return { refused: false, text: `no answer (${result.errorMessage.replace(/Internal net::Error: -?\d+/, "network error")})` };
}

const CAUSES = [
  "The computer and the TV must be on the same Wi-Fi network or subnet (a guest network, \"AP isolation\" on a router, or a wired/Wi-Fi split can separate them).",
  "A firewall may be blocking inbound UDP (the TV answers the search by unicast to this computer); allow node for private networks, and UDP port 1900 inbound.",
  "A VPN can take over multicast traffic; turn it off for the test.",
  "The TV must be on, not in deep standby, with its network features enabled; some TVs turn DIAL off in standby.",
];

interface Launched {
  route: string;
  sink: DialSink;
  confirmed: boolean;
  closed: boolean;
  allowStop: boolean;
  /** The stop request while it is running, so that an interrupt waits for it instead of sending another. */
  stopping: Promise<void> | null;
}

export async function runDialTest(options: DialTestOptions, io: DialTestIo): Promise<DialTestResult> {
  const scrubber = new Scrubber();
  const say = (line: string): void => io.print(scrubber.scrub(line));
  const records: RequestRecord[] = [];
  const answersByUrl = new Map<string, Answer>();
  const steps: Step[] = [];
  const answers: Array<[string, string]> = [];
  const diagnostics: string[] = [];
  const controller = new AbortController();
  const outer = options.signal;
  const forward = (): void => controller.abort();
  if (outer?.aborted === true) controller.abort();
  else outer?.addEventListener("abort", forward, { once: true });
  const signal = controller.signal;
  const guard = <T>(promise: Promise<T>): Promise<T> => new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Interrupted());
      return;
    }
    const onAbort = (): void => reject(new Interrupted());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      (error: unknown) => { signal.removeEventListener("abort", onAbort); reject(error instanceof Error ? error : new Error(String(error))); },
    );
  });

  const step = (name: string, result: StepResult, detail = ""): void => {
    steps.push({ name, result, detail });
    say(`  [${result.toUpperCase()}] ${name}${detail === "" ? "" : `: ${detail}`}`);
  };
  const describe = (from: number): string => records.slice(from).map((r) => `${r.method} ${r.status ?? "no answer"} in ${r.ms} ms`).join("; ");

  const chrome = process.versions.chrome ?? EMULATED_CHROME;
  const platform = process.platform;
  const osName = platform === "win32" ? "Windows" : platform === "darwin" ? "Mac OS X" : "Linux";
  const originOs = platform === "win32" ? "Windows" : platform === "darwin" ? "Mac-OS-X" : platform === "linux" ? "Linux" : platform;
  const listInterfaces = options.registry?.interfaces ?? ((): NetworkInterfaceInfo[] => listIPv4Interfaces());
  let interfaceCount = 0;
  let launchResult: ((ok: boolean) => void) | null = null;
  const innerHttp = createDialHttp({ origin: `package:Google-Chrome.${chrome.split(".")[0] ?? "0"}.${originOs}`, ...options.httpOptions });
  const http = recordingHttp(innerHttp, records, answersByUrl);
  const service = new DialService({
    hashToken: randomUUID(),
    http,
    ...(options.settleMs !== undefined ? { settleMs: options.settleMs } : {}),
    registry: {
      userAgent: `Chrome/${chrome} ${osName}`,
      ...options.registry,
      interfaces: () => {
        const list = listInterfaces();
        interfaceCount = Math.max(interfaceCount, list.length);
        return list;
      },
    },
    log: (message) => {
      if (message === "Successfully launched app.") launchResult?.(true);
      else if (message === "Failed to launch app.") launchResult?.(false);
      else diagnostics.push(message);
    },
  });

  const data: ReportData = {
    environment: { os: `${os.type()} ${os.release()} (${os.arch()})`, node: process.version, library: options.libraryVersion, interfaces: 0, browser: `Chrome/${chrome}` },
    device: null,
    devices: [],
    steps,
    requests: records,
    answers,
    appInfoXml: null,
    interrupted: false,
    date: new Date().toISOString().slice(0, 10),
  };

  const yesNo = async (question: string, fallback?: "yes" | "no"): Promise<"yes" | "no" | null> => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const reply = await guard(io.ask(question));
      if (reply === null) return null;
      const text = reply.trim().toLowerCase();
      if (text === "" && fallback !== undefined) return fallback;
      if (text === "y" || text === "yes") return "yes";
      if (text === "n" || text === "no") return "no";
      say("Please answer y or n.");
    }
    return null;
  };

  // What was opened on the device, so that it can be closed again however the run ends.
  let launched: Launched | null = null;
  let model = "";
  let exitCode = 0;

  const stopOpenedApp = async (): Promise<void> => {
    if (launched === null || launched.closed) return;
    const app = launched;
    app.closed = true;
    if (!app.allowStop) {
      say(`${APP} is still open on the device, which does not allow it to be stopped from here; close it with the TV's remote.`);
      return;
    }
    say(`Stopping ${APP} on the device...`);
    await within(app.stopping ?? service.provider.terminateRoute(app.route), 8000);
    if (app.confirmed) return;
    // The launch request was still in flight, and the device may have started the app anyway.
    const info = await within(service.sinks.fetchAppInfo(app.sink, APP), 8000);
    if (info?.appInfo?.state === "running") await within(http.delete(`${app.sink.appUrl}/${APP}/run`), 8000);
  };

  say(`electron-cast ${options.libraryVersion} DIAL test`);
  try {
    // 1. Discovery
    const discoverMs = options.discoverMs ?? 10_000;
    say(`Looking for DIAL devices for ${Math.round(discoverMs / 1000)} s...`);
    service.start();
    await wait(discoverMs, signal);
    const settle = (options.settleMs ?? 3000) + 2000;
    for (let waited = 0; waited < settle && service.registry.devices().length > service.sinks.sinks().length; waited += 100) await wait(100, signal);
    data.environment.interfaces = interfaceCount;

    const sinks = service.sinks.sinks();
    const candidates: Candidate[] = service.registry.devices().sort((a, b) => Number(a.label) - Number(b.label)).map((device) => {
      const sink = sinks.find((s) => s.ipAddress === device.ipAddress) ?? null;
      const answer = answersByUrl.get(device.descriptionUrl);
      const xmlDevice = deviceElement(answer);
      const status = records.find((r) => r.url === device.descriptionUrl)?.status ?? null;
      return {
        device, sink,
        manufacturer: field(xmlDevice, "manufacturer"),
        model: sink?.modelName ?? field(xmlDevice, "modelName"),
        rejected: sink === null ? rejectionReason(device, answer, status) : "",
        cast: null,
      };
    });
    for (const c of candidates) {
      scrubber.ip(c.device.ipAddress);
      const parsed = answersByUrl.has(c.device.descriptionUrl) ? parseXml(answersByUrl.get(c.device.descriptionUrl)?.body ?? "") : null;
      if (parsed !== null) registerIdentifiers(parsed, scrubber);
      if (c.sink !== null) {
        scrubber.secret(c.sink.name, "<friendly name>");
        scrubber.uuid(c.sink.id.slice("dial:".length));
      }
    }
    const usable = candidates.filter((c) => c.sink !== null);
    const castPort = options.castPort ?? 8009;
    // One TLS connection per device, opened and closed: a device that accepts it is a Cast device.
    await guard(Promise.all(usable.map(async (c) => {
      c.cast = await knockOnCastPort(c.device.ipAddress, castPort, signal);
    })));
    const isCast = (c: Candidate): boolean => c.cast?.ok === true;
    for (const message of diagnostics) say(`  note: ${message}`);

    if (candidates.length === 0) {
      step("Discovery", "fail", `no DIAL device answered on ${interfaceCount} network interface(s)${diagnostics.length > 0 ? ` (${diagnostics.join("; ")})` : ""}`);
      say("");
      say("No DIAL device was found. Likely causes:");
      for (const cause of CAUSES) {
        say(`  - ${cause}`);
        steps.push({ name: "Possible cause", result: "info", detail: cause });
      }
    } else {
      step("Discovery", usable.length > 0 ? "pass" : "fail",
        `${candidates.length} device(s) answered the search, ${usable.length} accepted by the library; ${interfaceCount} network interface(s) searched`);
      say("");
      say("DIAL devices found:");
      usable.forEach((c, i) => say(`  ${i + 1}. ${label(c)}${isCast(c) ? "  (also a Cast device: shown as Cast, not DIAL)" : ""}`));
      data.devices = usable.map((c, i) => `${i + 1}. ${label(c)}${isCast(c) ? " (accepts TLS on the Cast port: a Cast device)" : ""}`);
      for (const c of candidates.filter((x) => x.sink === null)) {
        say(`  - ${label(c)} answered but cannot be tested: ${c.rejected}`);
        steps.push({ name: "Device not accepted", result: "info", detail: `${label(c)}: ${c.rejected}` });
      }
    }

    // 2. Pick one
    let chosen: Candidate | null = null;
    const allCast = usable.length > 0 && usable.every(isCast);
    if (allCast) {
      say("");
      say(NO_DIAL_ONLY);
      steps.push({ name: "DIAL-only TV", result: "info", detail: NO_DIAL_ONLY });
    }
    if (usable.length > 0 && !(allCast && options.deviceIndex === undefined)) {
      let index = options.deviceIndex;
      if (index === undefined && (usable.length === 1 || options.yes === true)) index = 1;
      for (let attempt = 0; index === undefined && attempt < 3; attempt++) {
        const reply = await guard(io.ask(`Which device do you want to test? [1-${usable.length}]`));
        if (reply === null) break;
        const n = Number(reply.trim());
        if (Number.isInteger(n) && n >= 1 && n <= usable.length) index = n;
        else say(`Type a number from 1 to ${usable.length}.`);
      }
      if (index === undefined) {
        step("Choose a device", "fail", "no device was chosen");
        exitCode = 1;
      } else if (index < 1 || index > usable.length) {
        step("Choose a device", "fail", `device ${index} is not in the list of ${usable.length}`);
        exitCode = 1;
      } else {
        chosen = usable[index - 1] ?? null;
      }
    }

    if (chosen !== null && chosen.sink !== null) {
      const sink = chosen.sink;
      model = chosen.model;
      say("");
      say(`Testing: ${label(chosen)}`);
      const description = answersByUrl.get(chosen.device.descriptionUrl);
      const xmlDevice = deviceElement(description);
      const device: Array<[string, string]> = FIELDS.map(([name, element]): [string, string] => [name, field(xmlDevice, element)])
        .filter(([, value], i) => i < 3 || value !== "");
      if (description?.headers.server !== undefined) device.push(["Server header", description.headers.server]);
      device.push(["Application-URL", description?.headers["application-url"] ?? ""]);
      device.push(["SSDP answer", `cache max-age ${chosen.device.maxAge ?? "absent"}, CONFIGID ${chosen.device.configId ?? "absent"}`]);
      data.device = device;

      // 3. Read-only checks
      const descRecord = records.find((r) => r.url === chosen.device.descriptionUrl);
      step("Device description", "pass",
        `GET ${descRecord?.status ?? "?"} in ${descRecord?.ms ?? "?"} ms; the library read UDN, friendlyName, modelName and deviceType, and the Application-URL header`);

      let before = records.length;
      const youtube: DialAppInfoResult = await guard(service.sinks.fetchAppInfo(sink, APP));
      const body = answersByUrl.get(`${sink.appUrl}/${APP}`)?.body;
      if (body !== undefined) data.appInfoXml = redactAppInfo(body);
      if (youtube.appInfo !== null) {
        const info = youtube.appInfo;
        const keys = Object.keys(info.extraData);
        step(`App info: ${APP}`, "pass",
          `${describe(before)}; state ${info.state}; allowStop ${info.allowStop}; DIAL version ${info.dialVersion === "" ? "(none)" : info.dialVersion}; additionalData keys: ${keys.length === 0 ? "none" : keys.join(", ")}`);
      } else {
        const problem = appInfoProblem(youtube);
        step(`App info: ${APP}`, problem.refused ? "info" : "fail", problem.refused ? problem.text : `${describe(before)}; ${problem.text}`);
      }

      before = records.length;
      const netflix = await guard(service.sinks.fetchAppInfo(sink, OTHER_APP));
      if (netflix.appInfo !== null) step(`App info: ${OTHER_APP}`, "pass", `${describe(before)}; state ${netflix.appInfo.state}`);
      else {
        const problem = appInfoProblem(netflix);
        step(`App info: ${OTHER_APP}`, problem.refused ? "info" : "skip", problem.refused ? problem.text : `${describe(before)}; ${problem.text}`);
      }

      const cast = chosen.cast ?? { ok: false, ms: 0, detail: "not tried" };
      step(`TLS connection on port ${castPort} (opened and closed, nothing sent)`, "info", `${cast.ok ? "accepted" : "not accepted"}: ${cast.detail} in ${cast.ms} ms`);
      if (cast.ok) step("Cast device", "info", CAST_NOTE);

      // 4. Open YouTube, if the person agrees
      if (options.launch === false) {
        step(`Launch ${APP}`, "skip", "not requested (--read-only)");
      } else if (cast.ok) {
        step(`Launch ${APP}`, "skip", "this is a Cast device; the launch test is for DIAL-only TVs");
      } else if (youtube.appInfo === null) {
        step(`Launch ${APP}`, "skip", `the device did not give usable app info for ${APP}`);
      } else if (youtube.appInfo.state === "running") {
        step(`Launch ${APP}`, "skip", `${APP} is already running on the device; it was left alone`);
      } else {
        const allowStop = youtube.appInfo.allowStop;
        const question = `Open ${APP} on your ${chosen.model === "" ? "TV" : chosen.model}? It will show the ${APP} app for a few seconds. [y/N]`;
        let open: "yes" | "no" | null;
        if (options.yes === true) {
          say(question.replace("[y/N]", "(--yes: yes)"));
          open = "yes";
          answers.push([`Open ${APP}?`, "yes (--yes)"]);
        } else {
          open = await yesNo(question, "no");
          answers.push([`Open ${APP}?`, open ?? "no answer"]);
        }
        if (open !== "yes") {
          step(`Launch ${APP}`, "skip", "you chose not to open it");
        } else {
          before = records.length;
          // The launch is the library's own: a cast-dial: source, the SDK's client_connect, the provider's custom_dial_launch
          // offer answered with "launch with the source's data", then the POST and, later, the DELETE.
          const route = service.provider.createRoute(`cast-dial:${APP}?clientId=${CLIENT_ID}`, sink.id, DialRouteProvider.newPresentationId(), PAGE_ORIGIN).route;
          const mine: Launched = { route: route.id, sink, confirmed: false, closed: false, allowStop, stopping: null };
          launched = mine;
          const outcome = new Promise<boolean>((resolve) => { launchResult = resolve; });
          service.provider.on("messages", (routeId, messages) => {
            for (const text of messages) {
              const message = JSON.parse(text) as { type?: string; sequenceNumber?: number };
              if (message.type !== "custom_dial_launch") continue;
              service.provider.sendRouteMessage(routeId, JSON.stringify({
                type: "custom_dial_launch", message: { doLaunch: true }, clientId: CLIENT_ID, sequenceNumber: message.sequenceNumber,
              }));
            }
          });
          say(`Opening ${APP}...`);
          service.provider.sendRouteMessage(route.id, dialEnvelope("client_connect", null, CLIENT_ID));
          const ok = await guard(within(outcome, 40_000, signal));
          if (ok === true) mine.confirmed = true;
          if (ok !== true) {
            step(`Launch ${APP}`, "fail", `${describe(before)}${ok === undefined ? "; no result in 40 s" : ""}`);
            // The device may have started it before the request failed or timed out.
            mine.confirmed = false;
            await stopOpenedApp();
          } else {
            step(`Launch ${APP}`, "pass", describe(before));
            await wait(options.holdMs ?? 6000, signal);
            let seen: "yes" | "no" | null = null;
            if (options.yes === true) {
              answers.push([`Did ${APP} open on the TV?`, "not asked (--yes)"]);
            } else {
              seen = await yesNo(`Did ${APP} open on the TV? [y/n]`);
              answers.push([`Did ${APP} open on the TV?`, seen ?? "no answer"]);
            }
            if (seen === "yes") step(`${APP} appeared on the TV`, "pass", "your answer: yes");
            else if (seen === "no") step(`${APP} appeared on the TV`, "fail", "your answer: no");
            else step(`${APP} appeared on the TV`, "skip", "not answered");

            if (allowStop) {
              before = records.length;
              mine.closed = true;
              let failure = "";
              try {
                mine.stopping = service.provider.terminateRoute(route.id);
                await guard(mine.stopping);
              } catch (error) {
                if (error instanceof Interrupted) {
                  mine.closed = false;
                  throw error;
                }
                failure = error instanceof Error ? error.message : String(error);
              }
              step(`Stop ${APP}`, failure === "" ? "pass" : "fail", failure === "" ? describe(before) : `${describe(before)}; ${failure}`);
              await wait(options.closeMs ?? 1500, signal);
              let closed: "yes" | "no" | null = null;
              if (options.yes === true) {
                answers.push([`Did ${APP} close?`, "not asked (--yes)"]);
              } else {
                closed = await yesNo(`Did ${APP} close? [y/n]`);
                answers.push([`Did ${APP} close?`, closed ?? "no answer"]);
              }
              if (closed === "yes") step(`${APP} closed on the TV`, "pass", "your answer: yes");
              else if (closed === "no") step(`${APP} closed on the TV`, "fail", "your answer: no");
              else step(`${APP} closed on the TV`, "skip", "not answered");
            } else {
              step(`Stop ${APP}`, "skip", "the device says allowStop=false; no stop request was sent");
              say(`This device does not allow ${APP} to be stopped from here. Close it with the TV's remote.`);
              if (options.yes !== true) {
                const closed = await yesNo(`Is ${APP} closed on the TV now (close it with the remote)? [y/n]`);
                answers.push([`Is ${APP} closed on the TV now?`, closed ?? "no answer"]);
              }
              mine.closed = true;
            }
          }
        }
      }
    }
  } catch (error) {
    if (error instanceof Interrupted) {
      data.interrupted = true;
      exitCode = 130;
      say("");
      say("Interrupted.");
    } else {
      step("Unexpected error", "fail", error instanceof Error ? error.message : String(error));
      exitCode = 1;
    }
  } finally {
    try {
      await stopOpenedApp();
    } finally {
      service.stop();
      outer?.removeEventListener("abort", forward);
    }
  }
  return { report: renderReport(data, scrubber), interrupted: data.interrupted, exitCode, model };
}
