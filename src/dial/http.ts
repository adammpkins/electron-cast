// The HTTP side of DIAL: GET, POST and DELETE against a device, as Chromium's DialURLFetcher does them
// (chrome/browser/media/router/discovery/dial/dial_url_fetcher.cc), on node:http so the package stays dependency free.
import http from "node:http";
import https from "node:https";
import os from "node:os";

/** What a request ended with. `status` and `headers` are present whenever the device answered. */
export type DialHttpResult =
  | { ok: true; status: number; headers: Record<string, string>; body: string }
  | { ok: false; message: string; status?: number };

export interface DialHttp {
  /** `DialURLFetcher::Get`. `setOrigin` is false only for the device description. */
  get(url: string, setOrigin: boolean): Promise<DialHttpResult>;
  /** `DialURLFetcher::Post`; a null body posts nothing. */
  post(url: string, body: string | null): Promise<DialHttpResult>;
  /** `DialURLFetcher::Delete`. */
  delete(url: string): Promise<DialHttpResult>;
}

/** `kMaxRetries` (dial_url_fetcher.cc): GET is retried this often after a 5xx answer. */
const MAX_GET_RETRIES = 2;
/** `kMaxResponseSizeBytes` (dial_url_fetcher.cc). */
const MAX_RESPONSE_BYTES = 262144;

export interface DialHttpOptions {
  /**
   * The Origin header Chromium sends so that a web page cannot make the browser issue DIAL requests
   * (`GetFakeOriginForDialLaunch`): `package:<product>.<major>.<os>`.
   */
  origin?: string;
  /** GET timeout. Chromium sets none (a TODO in `DialActivityManager::CreateFetcher`), but Node would wait forever. */
  getTimeoutMs?: number;
  /** POST and DELETE timeout; an app launch can take a while on the device. */
  actionTimeoutMs?: number;
}

/** The product and OS parts of {@link DialHttpOptions.origin}, like `version_info::GetOSType()` (base/version_info). */
export function defaultDialOrigin(): string {
  const platform = os.platform();
  const osType = platform === "win32" ? "Windows" : platform === "darwin" ? "Mac-OS-X" : platform === "linux" ? "Linux" : platform;
  const major = (process.versions.chrome ?? "0").split(".")[0] ?? "0";
  return `package:Google-Chrome.${major}.${osType}`;
}

/** The `net::Error` a failure would carry in Chromium, used in the message a page reads from an error reply. */
function netErrorCode(error: NodeJS.ErrnoException): number {
  switch (error.code) {
    case "ECONNREFUSED": return -102;
    case "ECONNRESET": return -101;
    case "ETIMEDOUT": return -118;
    case "EHOSTUNREACH":
    case "ENETUNREACH": return -109;
    case "ENOTFOUND": return -105;
    case "EPIPE": return -324;
    default: return -2;
  }
}

type Raw =
  | { kind: "response"; status: number; headers: Record<string, string>; body: string; tooBig: boolean; location: boolean }
  | { kind: "error"; message: string };

function once(method: string, urlString: string, headers: Record<string, string>, body: string | null, timeoutMs: number): Promise<Raw> {
  return new Promise<Raw>((resolve) => {
    let url: URL;
    try {
      url = new URL(urlString);
    } catch {
      resolve({ kind: "error", message: "Internal net::Error: -300" });
      return;
    }
    const lib = url.protocol === "https:" ? https : http;
    let done = false;
    const finish = (raw: Raw): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(raw);
    };
    const req = lib.request(url, { method, headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) {
          finish({ kind: "response", status: res.statusCode ?? 0, headers: {}, body: "", tooBig: true, location: false });
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => {
        const flat: Record<string, string> = {};
        for (const [name, value] of Object.entries(res.headers)) {
          if (value !== undefined) flat[name.toLowerCase()] = Array.isArray(value) ? (value[0] ?? "") : value;
        }
        finish({
          kind: "response",
          status: res.statusCode ?? 0,
          headers: flat,
          // Kept as latin1 so the caller can check that the bytes are UTF-8.
          body: Buffer.concat(chunks).toString("latin1"),
          tooBig: false,
          location: flat.location !== undefined,
        });
      });
      res.on("error", (e: NodeJS.ErrnoException) => finish({ kind: "error", message: `Internal net::Error: ${netErrorCode(e)}` }));
    });
    const timer = setTimeout(() => {
      finish({ kind: "error", message: "Internal net::Error: -7" });
      req.destroy();
    }, timeoutMs);
    timer.unref?.();
    req.on("error", (e: NodeJS.ErrnoException) => finish({ kind: "error", message: `Internal net::Error: ${netErrorCode(e)}` }));
    if (body !== null) req.write(body);
    req.end();
  });
}

/** Creates the fetcher: no proxy, no cache, no cookies, no redirects, a 256 KiB body limit. */
export function createDialHttp(options: DialHttpOptions = {}): DialHttp {
  const origin = options.origin ?? defaultDialOrigin();
  const getTimeout = options.getTimeoutMs ?? 10_000;
  const actionTimeout = options.actionTimeoutMs ?? 30_000;

  async function run(method: string, url: string, setOrigin: boolean, body: string | null, retries: number, timeoutMs: number): Promise<DialHttpResult> {
    const headers: Record<string, string> = { Connection: "close" };
    if (setOrigin) headers.Origin = origin;
    if (method === "POST") {
      headers["Content-Length"] = String(Buffer.byteLength(body ?? "", "utf8"));
      if (body !== null) headers["Content-Type"] = "text/plain";
    }
    for (let attempt = 0; ; attempt++) {
      const raw = await once(method, url, headers, method === "POST" ? (body ?? "") : null, timeoutMs);
      if (raw.kind === "error") return { ok: false, message: raw.message };
      // Section 5.4 of the DIAL spec prohibits redirects; Chromium reports one as an error with no answer.
      if (raw.status >= 300 && raw.status < 400 && raw.location) return { ok: false, message: "Redirect not allowed" };
      if (raw.tooBig) return { ok: false, message: "Internal net::Error: -12" };
      if (raw.status >= 500 && attempt < retries) continue;
      // SimpleURLLoader fails any other non-2xx answer as ERR_HTTP_RESPONSE_CODE_FAILURE (-379).
      if (raw.status < 200 || raw.status >= 300) return { ok: false, message: "Internal net::Error: -379", status: raw.status };
      return { ok: true, status: raw.status, headers: raw.headers, body: raw.body };
    }
  }

  return {
    async get(url, setOrigin) {
      const result = await run("GET", url, setOrigin, null, MAX_GET_RETRIES, getTimeout);
      return checkBody(result, true);
    },
    async post(url, body) {
      return checkBody(await run("POST", url, true, body, 0, actionTimeout), false);
    },
    async delete(url) {
      return checkBody(await run("DELETE", url, true, null, 0, actionTimeout), false);
    },
  };
}

/** `DialURLFetcher::ProcessResponse`: a GET needs a body; every body must be UTF-8. */
function checkBody(result: DialHttpResult, isGet: boolean): DialHttpResult {
  if (!result.ok) return result;
  if (isGet && result.body === "") return { ok: false, message: "Missing or empty response", status: result.status };
  try {
    // Bodies are carried as latin1 text by `once`; reinterpret the bytes as UTF-8.
    const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(result.body, "latin1"));
    return { ...result, body: text };
  } catch {
    return { ok: false, message: "Invalid response encoding", status: result.status };
  }
}
