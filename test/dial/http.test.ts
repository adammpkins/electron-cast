// The DIAL HTTP layer against a real server on localhost (DialURLFetcher: dial_url_fetcher.cc).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createDialHttp, defaultDialOrigin } from "../../src/dial/http.ts";

interface Seen { method: string; url: string; origin: string | undefined; contentType: string | undefined; body: string }
const seen: Seen[] = [];
let flaky = 0;

const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    seen.push({
      method: req.method ?? "", url: req.url ?? "", origin: req.headers.origin, contentType: req.headers["content-type"],
      body: Buffer.concat(chunks).toString("utf8"),
    });
    switch (req.url) {
      case "/ok": res.writeHead(200).end("<hello/>"); return;
      case "/empty": res.writeHead(200).end(); return;
      case "/redirect": res.writeHead(302, { Location: "http://127.0.0.1:1/" }).end("x"); return;
      case "/flaky":
        if (++flaky <= 2) res.writeHead(503).end("busy");
        else res.writeHead(200).end("<up/>");
        return;
      case "/down": res.writeHead(500).end("no"); return;
      case "/missing": res.writeHead(404).end("no"); return;
      case "/big": res.writeHead(200).end("x".repeat(300_000)); return;
      case "/latin1": res.writeHead(200).end(Buffer.from([0xff, 0xfe, 0x41])); return;
      case "/created": res.writeHead(201, { Location: "http://127.0.0.1/apps/YouTube/run" }).end(); return;
      case "/hang": return;
      default: res.writeHead(404).end();
    }
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => {
  server.closeAllConnections();
  server.close();
});

const dial = createDialHttp({ origin: "package:Test.1.Windows", getTimeoutMs: 300, actionTimeoutMs: 300 });

test("a GET returns the body, and sends the fake Origin except for the device description", async () => {
  seen.length = 0;
  const app = await dial.get(`${base}/ok`, true);
  assert.deepEqual(app.ok && app.body, "<hello/>");
  const description = await dial.get(`${base}/ok`, false);
  assert.ok(description.ok);
  assert.equal(seen[0]?.origin, "package:Test.1.Windows");
  assert.equal(seen[1]?.origin, undefined);
});

test("the default Origin names the product's major version and the OS like Chrome's", () => {
  assert.match(defaultDialOrigin(), /^package:Google-Chrome\.\d+\.(Windows|Mac-OS-X|Linux)$/);
});

test("an empty GET body is an error, a redirect is refused, and a 4xx or 5xx is an error with its status", async () => {
  const empty = await dial.get(`${base}/empty`, true);
  assert.deepEqual(empty, { ok: false, message: "Missing or empty response", status: 200 });
  const redirected = await dial.get(`${base}/redirect`, true);
  assert.deepEqual(redirected, { ok: false, message: "Redirect not allowed" });
  const missing = await dial.get(`${base}/missing`, true);
  assert.equal(!missing.ok && missing.status, 404);
});

test("a GET is retried twice after a 5xx answer, then fails with that status", async () => {
  seen.length = 0;
  flaky = 0;
  const retried = await dial.get(`${base}/flaky`, true);
  assert.equal(retried.ok && retried.body, "<up/>");
  assert.equal(seen.filter((s) => s.url === "/flaky").length, 3);
  seen.length = 0;
  const down = await dial.get(`${base}/down`, true);
  assert.equal(!down.ok && down.status, 500);
  assert.equal(seen.length, 3);
});

test("a POST is sent as text/plain with the Origin header and is never retried", async () => {
  seen.length = 0;
  const created = await dial.post(`${base}/created`, "pairingCode=abc");
  assert.ok(created.ok);
  assert.equal(created.ok && created.status, 201);
  assert.equal(created.ok && created.headers.location, "http://127.0.0.1/apps/YouTube/run");
  assert.deepEqual(seen.map((s) => [s.method, s.contentType, s.origin, s.body]), [["POST", "text/plain", "package:Test.1.Windows", "pairingCode=abc"]]);
  seen.length = 0;
  const failed = await dial.post(`${base}/down`, null);
  assert.equal(!failed.ok && failed.status, 500);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.contentType, undefined, "no body, no content type");
});

test("a DELETE carries the Origin header, and an empty answer is fine", async () => {
  seen.length = 0;
  const res = await dial.delete(`${base}/empty`);
  assert.ok(res.ok);
  assert.deepEqual(seen.map((s) => [s.method, s.origin]), [["DELETE", "package:Test.1.Windows"]]);
});

test("a body over 256 KiB, a body that is not UTF-8 and a device that never answers are errors", async () => {
  const big = await dial.get(`${base}/big`, true);
  assert.equal(big.ok, false);
  const bad = await dial.get(`${base}/latin1`, true);
  assert.deepEqual(bad, { ok: false, message: "Invalid response encoding", status: 200 });
  const hung = await dial.get(`${base}/hang`, true);
  assert.equal(hung.ok, false);
});

test("a refused connection is a network error with no status", async () => {
  const res = await dial.get("http://127.0.0.1:1/x", true);
  assert.equal(res.ok, false);
  assert.equal(res.ok ? undefined : res.status, undefined);
});
