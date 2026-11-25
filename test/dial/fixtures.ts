// Shared fakes for the DIAL tests: SSDP answers, device and app documents, and a scripted HTTP layer.
import type { DialHttp, DialHttpResult } from "../../src/dial/http.ts";

export const DEVICE_IP = "192.168.1.20";
export const APP_URL = `http://${DEVICE_IP}:8008/apps`;
export const DESCRIPTION_URL = `http://${DEVICE_IP}:8008/ssdp/device-desc.xml`;
export const UDN = "uuid:AAAA1111-2222-3333-4444-555566667777";
export const SINK_ID = "dial:aaaa1111222233334444555566667777";

export function ssdpAnswer(over: { location?: string; usn?: string | null; extra?: string } = {}): string {
  const lines = [
    "HTTP/1.1 200 OK",
    `LOCATION: ${over.location ?? DESCRIPTION_URL}`,
    "CACHE-CONTROL: max-age=1800",
    "ST: urn:dial-multiscreen-org:service:dial:1",
  ];
  if (over.usn !== null) lines.push(`USN: ${over.usn ?? `${UDN}::urn:dial-multiscreen-org:service:dial:1`}`);
  if (over.extra !== undefined) lines.push(over.extra);
  return `${lines.join("\r\n")}\r\n\r\n`;
}

export function descriptionXml(over: { udn?: string; friendlyName?: string; modelName?: string } = {}): string {
  return `<?xml version="1.0"?><root xmlns="urn:schemas-upnp-org:device-1-0"><specVersion><major>1</major><minor>0</minor></specVersion>`
    + `<device><deviceType>urn:dial-multiscreen-org:device:dial:1</deviceType>`
    + `<friendlyName>${over.friendlyName ?? "Living Room TV"}</friendlyName>`
    + `<modelName>${over.modelName ?? "Smart TV"}</modelName><UDN>${over.udn ?? UDN}</UDN></device></root>`;
}

export function appInfoXml(state: "running" | "stopped" | "installable" = "stopped", extra = ""): string {
  return `<?xml version="1.0" encoding="UTF-8"?><service xmlns="urn:dial-multiscreen-org:schemas:dial" dialVer="2.1">`
    + `<name>YouTube</name><options allowStop="true"/><state>${state}</state>`
    + `${state === "running" ? `<link rel="run" href="run"/>` : ""}${extra}</service>`;
}

export interface Call { method: "GET" | "POST" | "DELETE"; url: string; body?: string | null; setOrigin?: boolean; signal?: AbortSignal }
type Reply = DialHttpResult | ((call: Call) => DialHttpResult | Promise<DialHttpResult>);

/** A DialHttp that answers from a table keyed by `"METHOD url"`; anything unlisted fails like a refused connection. */
export class FakeHttp implements DialHttp {
  readonly calls: Call[] = [];
  readonly replies = new Map<string, Reply>();

  reply(method: string, url: string, reply: Reply): this {
    this.replies.set(`${method} ${url}`, reply);
    return this;
  }

  private async answer(call: Call): Promise<DialHttpResult> {
    this.calls.push(call);
    const reply = this.replies.get(`${call.method} ${call.url}`);
    if (reply === undefined) return { ok: false, message: "Internal net::Error: -102" };
    return typeof reply === "function" ? reply(call) : reply;
  }

  get(url: string, setOrigin: boolean, signal?: AbortSignal): Promise<DialHttpResult> {
    return this.answer({ method: "GET", url, setOrigin, ...(signal !== undefined ? { signal } : {}) });
  }
  post(url: string, body: string | null, signal?: AbortSignal): Promise<DialHttpResult> {
    return this.answer({ method: "POST", url, body, ...(signal !== undefined ? { signal } : {}) });
  }
  delete(url: string, signal?: AbortSignal): Promise<DialHttpResult> {
    return this.answer({ method: "DELETE", url, ...(signal !== undefined ? { signal } : {}) });
  }
  aborted = false;
  abortAll(): void {
    this.aborted = true;
  }
}

export const ok = (body = "", headers: Record<string, string> = {}, status = 200): DialHttpResult => ({ ok: true, status, headers, body });
export const httpError = (status: number): DialHttpResult => ({ ok: false, message: "Internal net::Error: -379", status });

/** A FakeHttp for one healthy device whose YouTube app is in `state`. */
export function healthyDevice(state: "running" | "stopped" = "stopped"): FakeHttp {
  return new FakeHttp()
    .reply("GET", DESCRIPTION_URL, ok(descriptionXml(), { "application-url": `${APP_URL}/` }))
    .reply("GET", `${APP_URL}/YouTube`, ok(appInfoXml(state)));
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Lets every promise chain that needs no timer run to its end (the fakes answer from microtasks). */
export async function flush(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise<void>((r) => setImmediate(r));
}

/** Waits until `condition` holds, polling between event-loop turns; fails the test on `timeoutMs` instead of racing a fixed delay. */
export async function until(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await new Promise<void>((r) => setImmediate(r));
  }
}
