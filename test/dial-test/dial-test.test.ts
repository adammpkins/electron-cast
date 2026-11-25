// The DIAL device test against a fake device on the loopback interface: what it lists, what it asks, what it sends, what
// it leaves out of the report, and that Ctrl-C closes what it opened.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runDialTest, redactAppInfo, type DialTestIo, type DialTestOptions } from "../../src/dial-test/runner.ts";
import { runCli } from "../../src/dial-test/cli-main.ts";
import { buildIssueUrl } from "../../src/dial-test/report.ts";
import { Scrubber } from "../../src/dial-test/scrub.ts";
import { FakeDialDevice, SECRETS } from "./fake-device.ts";

interface Script {
  io: DialTestIo;
  printed: string[];
  asked: string[];
}

/** Answers questions from a list; an answer of `null` means the input ended. A function decides by the question. */
function script(answers: Array<string | null> | ((question: string) => Promise<string | null>)): Script {
  const printed: string[] = [];
  const asked: string[] = [];
  const queue = Array.isArray(answers) ? [...answers] : null;
  return {
    printed, asked,
    io: {
      print: (line) => printed.push(line),
      ask: (question) => {
        asked.push(question);
        if (queue === null) return (answers as (q: string) => Promise<string | null>)(question);
        return Promise.resolve(queue.length === 0 ? null : (queue.shift() ?? null));
      },
    },
  };
}

async function withDevice(body: (device: FakeDialDevice) => Promise<void>, start: { cast?: boolean } = {}): Promise<void> {
  const device = new FakeDialDevice();
  await device.start(start);
  try {
    await body(device);
  } finally {
    await device.stop();
  }
}

const options = (device: FakeDialDevice, extra: Partial<DialTestOptions> = {}): DialTestOptions => ({
  libraryVersion: "9.9.9-test", ...device.options(), ...extra,
});

/** Nothing the fake device calls private is in `text`, and the device's address was replaced. */
function assertScrubbed(text: string): void {
  for (const secret of [SECRETS.friendlyName, SECRETS.serial, SECRETS.udn, SECRETS.udn.slice(5), SECRETS.udn.slice(5).toLowerCase(),
    SECRETS.udn.slice(5).replaceAll("-", "").toLowerCase(), SECRETS.mac, SECRETS.user, "127.0.0.1", "localhost"]) {
    assert.ok(!text.toLowerCase().includes(secret.toLowerCase()), `leaked ${secret}`);
  }
}

test("discovery lists a device as its manufacturer and model only, and reads the read-only things", async () => {
  await withDevice(async (device) => {
    const s = script([]);
    const result = await runDialTest(options(device, { launch: false }), s.io);
    assert.equal(result.exitCode, 0);
    assert.ok(s.printed.includes("  1. Acme Electronics Smart TV 9000"), s.printed.join("\n"));
    assert.deepEqual(s.asked, [], "one device and no launch: nothing to ask");
    assert.match(result.report, /\*\*PASS\*\* Discovery: 1 device\(s\) answered the search, 1 accepted by the library; 1 network interface\(s\) searched/);
    assert.match(result.report, /- Manufacturer: Acme Electronics/);
    assert.match(result.report, /- Model number: ST9000/);
    assert.match(result.report, /- Software version: 5\.6\.7/);
    assert.match(result.report, /\*\*PASS\*\* App info: YouTube: GET 200 in \d+ ms; state stopped; allowStop true; DIAL version 2\.1; additionalData keys: screenId/);
    assert.match(result.report, /\*\*SKIP\*\* App info: Netflix: GET no answer in \d+ ms|\*\*SKIP\*\* App info: Netflix: GET 404 in \d+ ms/);
    assert.match(result.report, /\*\*INFO\*\* TLS connection on port \d+ .*: not accepted: ECONNREFUSED/);
    assert.match(result.report, /\*\*SKIP\*\* Launch YouTube: not requested/);
    assert.match(result.report, /\| GET http:\/\/192\.0\.2\.1:\d+\/desc\.xml \| 200 \| \d+ ms \|/);
    assert.equal(device.seen.filter((r) => r.method !== "GET").length, 0, "read-only: no POST or DELETE");
    assert.equal(device.tlsConnections, 0);
  });
});

test("a device that also accepts TLS on the Cast port is reported, and nothing is sent on the connection", async () => {
  await withDevice(async (device) => {
    const result = await runDialTest(options(device, { launch: false, deviceIndex: 1 }), script([]).io);
    assert.match(result.report, /\*\*INFO\*\* TLS connection on port \d+ .*: accepted: TLS handshake completed \(TLSv1\.[23]\)/);
    // The device sees the connection a moment after the client has closed it.
    for (let i = 0; i < 100 && device.tlsConnections === 0; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(device.tlsConnections, 1);
  }, { cast: true });
});

test("the report names no friendly name, serial number, UDN, MAC, address, host or app-info value", async () => {
  await withDevice(async (device) => {
    const s = script(["y", "y", "y"]);
    const result = await runDialTest(options(device), s.io);
    assertScrubbed(result.report);
    assertScrubbed(s.printed.join("\n"));
    assertScrubbed(s.asked.join("\n"));
    assert.match(result.report, /192\.0\.2\.1/);
    assert.match(result.report, /<screenId>REDACTED<\/screenId>/);
    assert.match(result.report, /Application-URL: http:\/\/192\.0\.2\.1:\d+\/apps\//);
    assert.match(result.report, /^```xml\n<\?xml/m);
  });
});

test("a 403 on app info is reported as the device's refusal, without a network error code outside the request table", async () => {
  await withDevice(async (device) => {
    device.refuseOrigin = true;
    const s = script([]);
    const result = await runDialTest(options(device), s.io);
    const [results = "", requests = ""] = result.report.split("## Requests");
    assert.match(results, /\*\*INFO\*\* App info: YouTube: GET 403: the device refused requests that carry Chrome's DIAL origin \(Cast devices do this; Chrome treats the app as unavailable over DIAL and reaches them over Cast instead\)/);
    assert.match(results, /\*\*INFO\*\* App info: Netflix: GET 403: the device refused/);
    assert.ok(!results.includes("net::Error"), results);
    assert.ok(!s.printed.join("\n").includes("net::Error"));
    assert.match(requests, /\| GET http:\/\/192\.0\.2\.1:\d+\/apps\/YouTube \| 403 \(Internal net::Error: -379\) \|/);
    assert.match(results, /\*\*SKIP\*\* Launch YouTube: the device did not give usable app info/);
    assert.deepEqual(s.asked, []);
  });
});

test("a device that accepts TLS on the Cast port is marked as a Cast device, is not launched on, and ends the run with the DIAL-only note", async () => {
  await withDevice(async (device) => {
    const s = script(["y"]);
    const result = await runDialTest(options(device), s.io);
    assert.ok(s.printed.includes("  1. Acme Electronics Smart TV 9000  (also a Cast device: shown as Cast, not DIAL)"), s.printed.join("\n"));
    assert.ok(s.printed.includes("No DIAL-only TV found. This test is for TVs without built-in Chromecast."));
    assert.deepEqual(s.asked, [], "all devices are Cast devices: nothing is picked or opened");
    assert.match(result.report, /## Devices found\n\n- 1\. Acme Electronics Smart TV 9000 \(accepts TLS on the Cast port: a Cast device\)/);
    assert.match(result.report, /\*\*INFO\*\* DIAL-only TV: No DIAL-only TV found/);
    assert.deepEqual(device.seen.filter((r) => r.method !== "GET"), []);

    // Asked for by number, it is still read, and the launch is still skipped.
    const named = await runDialTest(options(device, { deviceIndex: 1 }), script(["y"]).io);
    assert.match(named.report, /\*\*INFO\*\* Cast device: This device accepts TLS on the Cast port, so it is a Cast device\. electron-cast, like Chrome, shows it as a Cast device rather than a DIAL one \(CreateCastSinkFromDialSink\)/);
    assert.match(named.report, /\*\*SKIP\*\* Launch YouTube: this is a Cast device/);
    assert.deepEqual(device.seen.filter((r) => r.method !== "GET"), []);
  }, { cast: true });
});

test("the scrubber maps an address once and never maps its own output again", () => {
  const scrubber = new Scrubber();
  scrubber.secret("Bedroom Roku", "<friendly name>");
  const text = "GET http://10.1.2.3:8008/apps and again 10.1.2.3, then 10.9.9.9; mac aa:bb:cc:dd:ee:ff; Bedroom ROKU; "
    + "uuid 123e4567-e89b-12d3-a456-426614174000; http://tv.example.test/x; http://[fe80::1]:80/";
  const out = scrubber.scrub(text);
  assert.equal(out, "GET http://192.0.2.1:8008/apps and again 192.0.2.1, then 192.0.2.2; mac <mac>; <friendly name>; "
    + "uuid <uuid>; http://host.invalid/x; http://[<ipv6>]:80/");
  assert.equal(scrubber.scrub(out), out);
});

test("a version that looks like an address is not taken for one", () => {
  const scrubber = new Scrubber();
  const text = "- OS: Linux 5.15.167.4-microsoft-standard-WSL2 (x64)\n- Browser identity sent: Chrome/142.0.0.0\n- Firmware version: 10.2.3.4\n"
    + "UA Chrome/142.0.0.0 Windows, version 9.8.7.6, firmware: 1.2.3.4\n- Application-URL: http://10.1.2.3:8008/apps/\n";
  assert.equal(scrubber.scrub(text), text.replace("10.1.2.3", "192.0.2.1"));
});

test("app info keeps its shape and loses what is under additionalData", () => {
  const xml = "<service><name>YouTube</name><additionalData><a x=\"1\">secret</a><b><![CDATA[more]]></b></additionalData><state>stopped</state></service>";
  assert.equal(redactAppInfo(xml),
    "<service><name>YouTube</name><additionalData><a x=\"REDACTED\">REDACTED</a><b>REDACTED</b></additionalData><state>stopped</state></service>");
});

test("a yes opens YouTube the way the library launches it, and a stop follows; every answer is recorded", async () => {
  await withDevice(async (device) => {
    const s = script(["y", "y", "y"]);
    const result = await runDialTest(options(device), s.io);
    assert.deepEqual(s.asked, [
      "Open YouTube on your Smart TV 9000? It will show the YouTube app for a few seconds. [y/N]",
      "Did YouTube open on the TV? [y/n]",
      "Did YouTube close? [y/n]",
    ]);
    const mutating = device.seen.filter((r) => r.method !== "GET");
    assert.deepEqual(mutating.map((r) => `${r.method} ${r.url}`), ["POST /apps/YouTube", "DELETE /apps/YouTube/run"]);
    // Chrome's launch: the Origin of a package, and an empty POST (no dialPostData in the source).
    assert.match(mutating[0]?.origin ?? "", /^package:Google-Chrome\.\d+\.(Windows|Linux|Mac-OS-X)$/);
    assert.equal(mutating[0]?.contentLength, "0");
    assert.equal(mutating[0]?.body, "");
    assert.equal(device.state, "stopped");
    assert.match(result.report, /\*\*PASS\*\* Launch YouTube: GET 200 in \d+ ms; POST 201 in \d+ ms/);
    assert.match(result.report, /\*\*PASS\*\* YouTube appeared on the TV: your answer: yes/);
    assert.match(result.report, /\*\*PASS\*\* Stop YouTube: DELETE 200 in \d+ ms/);
    assert.match(result.report, /\*\*PASS\*\* YouTube closed on the TV: your answer: yes/);
    assert.match(result.report, /- Open YouTube\? yes/);
    assert.match(result.report, /\| POST http:\/\/192\.0\.2\.1:\d+\/apps\/YouTube \| 201 \| \d+ ms \|/);
    assert.match(result.report, /\| DELETE http:\/\/192\.0\.2\.1:\d+\/apps\/YouTube\/run \| 200 \| \d+ ms \|/);
  });
});

test("a no to a question, and a no to the launch, are recorded as given", async () => {
  await withDevice(async (device) => {
    const declined = await runDialTest(options(device), script(["n"]).io);
    assert.deepEqual(device.seen.filter((r) => r.method !== "GET"), [], "nothing is opened without a yes");
    assert.match(declined.report, /\*\*SKIP\*\* Launch YouTube: you chose not to open it/);
    assert.match(declined.report, /- Open YouTube\? no/);

    const blank = await runDialTest(options(device), script([""]).io);
    assert.deepEqual(device.seen.filter((r) => r.method !== "GET"), [], "the default of [y/N] is no");
    assert.match(blank.report, /- Open YouTube\? no/);

    const failed = await runDialTest(options(device), script(["y", "n", "n"]).io);
    assert.match(failed.report, /\*\*FAIL\*\* YouTube appeared on the TV: your answer: no/);
    assert.match(failed.report, /\*\*FAIL\*\* YouTube closed on the TV: your answer: no/);
  });
});

test("--yes opens without asking and does not ask what was seen", async () => {
  await withDevice(async (device) => {
    const s = script([]);
    const result = await runDialTest(options(device, { yes: true }), s.io);
    assert.deepEqual(s.asked, []);
    assert.deepEqual(device.seen.filter((r) => r.method !== "GET").map((r) => r.method), ["POST", "DELETE"]);
    assert.match(result.report, /- Did YouTube open on the TV\? not asked \(--yes\)/);
  });
});

test("a device that does not allow stop is not sent a stop, and the person is told to close it", async () => {
  await withDevice(async (device) => {
    device.allowStop = false;
    const s = script(["y", "y", "y"]);
    const result = await runDialTest(options(device), s.io);
    assert.deepEqual(device.seen.filter((r) => r.method !== "GET").map((r) => r.method), ["POST"]);
    assert.match(result.report, /\*\*SKIP\*\* Stop YouTube: the device says allowStop=false; no stop request was sent/);
    assert.match(result.report, /allowStop false/);
    assert.ok(s.printed.some((l) => l.includes("Close it with the TV's remote")));
    assert.equal(s.asked.at(-1), "Is YouTube closed on the TV now (close it with the remote)? [y/n]");
  });
});

test("an app that is already running on the device is left alone", async () => {
  await withDevice(async (device) => {
    device.state = "running";
    const s = script(["y"]);
    const result = await runDialTest(options(device), s.io);
    assert.deepEqual(s.asked, []);
    assert.deepEqual(device.seen.filter((r) => r.method !== "GET"), []);
    assert.match(result.report, /\*\*SKIP\*\* Launch YouTube: YouTube is already running/);
  });
});

test("with no device the report still comes, with the likely causes", async () => {
  await withDevice(async (device) => {
    device.answers = false;
    const s = script([]);
    const result = await runDialTest(options(device), s.io);
    assert.equal(result.exitCode, 0);
    assert.match(result.report, /\*\*FAIL\*\* Discovery: no DIAL device answered on 1 network interface\(s\)/);
    assert.match(result.report, /same Wi-Fi network or subnet/);
    assert.match(result.report, /blocking inbound UDP/);
    assert.match(result.report, /VPN/);
    assert.match(result.report, /No device was tested\./);
    assert.ok(s.printed.some((l) => l.includes("No DIAL device was found")));
    assert.deepEqual(device.seen, []);
  });
});

test("a device the library does not accept is named with the reason and cannot be chosen", async () => {
  await withDevice(async (device) => {
    device.sendApplicationUrl = false;
    const s = script([]);
    const result = await runDialTest(options(device), s.io);
    assert.match(result.report, /\*\*FAIL\*\* Discovery: 1 device\(s\) answered the search, 0 accepted by the library/);
    assert.match(result.report, /\*\*INFO\*\* Device not accepted: Acme Electronics Smart TV 9000: the description has no Application-URL header/);
    assert.match(result.report, /No device was tested\./);
    assert.deepEqual(s.asked, []);
  });
});

test("--device picks from the list, and a number outside it is a failed run", async () => {
  await withDevice(async (device) => {
    const ok = await runDialTest(options(device, { launch: false, deviceIndex: 1 }), script([]).io);
    assert.equal(ok.exitCode, 0);
    const out = await runDialTest(options(device, { launch: false, deviceIndex: 4 }), script([]).io);
    assert.equal(out.exitCode, 1);
    assert.match(out.report, /\*\*FAIL\*\* Choose a device: device 4 is not in the list of 1/);
  });
});

test("Ctrl-C while YouTube is open on the TV stops it before the run ends", async () => {
  await withDevice(async (device) => {
    const controller = new AbortController();
    const s = script((question) => {
      if (question.startsWith("Open")) return Promise.resolve("y");
      // The person is looking at the TV; Ctrl-C arrives and the answer never does.
      controller.abort();
      return new Promise<string | null>(() => undefined);
    });
    const result = await runDialTest(options(device, { signal: controller.signal }), s.io);
    assert.equal(result.interrupted, true);
    assert.equal(result.exitCode, 130);
    assert.deepEqual(device.seen.filter((r) => r.method !== "GET").map((r) => `${r.method} ${r.url}`), ["POST /apps/YouTube", "DELETE /apps/YouTube/run"]);
    assert.equal(device.state, "stopped");
    assert.match(result.report, /run was interrupted/);
    assertScrubbed(result.report);
  });
});

test("Ctrl-C during discovery ends the run at once and opens nothing", async () => {
  await withDevice(async (device) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const started = Date.now();
    const result = await runDialTest(options(device, { signal: controller.signal, discoverMs: 10_000 }), script([]).io);
    assert.ok(Date.now() - started < 3000);
    assert.equal(result.interrupted, true);
    assert.deepEqual(device.seen.filter((r) => r.method !== "GET"), []);
  });
});

test("the issue link carries the report, and a long report is cut at a line with a pointer to the file", () => {
  const short = buildIssueUrl("DIAL test: Smart TV 9000", "# Report\n\nline with é and 😀 | pipe\n");
  assert.equal(short.truncated, false);
  const url = new URL(short.url);
  assert.equal(`${url.origin}${url.pathname}`, "https://github.com/adammpkins/electron-cast/issues/new");
  assert.equal(url.searchParams.get("title"), "DIAL test: Smart TV 9000");
  assert.equal(url.searchParams.get("body"), "# Report\n\nline with é and 😀 | pipe\n");

  const lines = Array.from({ length: 400 }, (_, i) => `line ${i} 😀 ${"x".repeat(30)}`);
  const long = buildIssueUrl("DIAL test", lines.join("\n"), { fileName: "my-report.md" });
  assert.equal(long.truncated, true);
  assert.ok(long.url.length <= 7000, `length ${long.url.length}`);
  const body = new URL(long.url).searchParams.get("body") ?? "";
  assert.ok(body.startsWith("line 0 "));
  assert.match(body, /Attach the whole of my-report\.md to this issue\./);
  assert.ok(!body.includes("�"), "no character was split");
  assert.ok(!body.includes("line 399"));
  // The cut falls between lines: every line kept is whole.
  for (const line of body.split("\n").filter((l) => l.startsWith("line "))) assert.match(line, /^line \d+ 😀 x{30}$/);

  const oneLine = buildIssueUrl("t", "😀".repeat(5000));
  assert.ok(oneLine.url.length <= 7000);
  assert.ok(!(new URL(oneLine.url).searchParams.get("body") ?? "").includes("�"));
});

test("the command writes the report file, prints the link, and takes its options", async () => {
  await withDevice(async (device) => {
    const written: Array<[string, string]> = [];
    const out: string[] = [];
    const code = await runCli({
      argv: ["dial-test", "--yes", "--device", "1", "--out", "report.md"],
      cwd: "/work", libraryVersion: "9.9.9-test",
      out: (l) => out.push(l), err: (l) => out.push(l),
      ask: () => Promise.resolve(null),
      overrides: device.options(),
      writeFile: (file, text) => written.push([file, text]),
    });
    assert.equal(code, 0);
    assert.equal(written.length, 1);
    assert.match(written[0]?.[0] ?? "", /report\.md$/);
    assert.match(written[0]?.[1] ?? "", /^# DIAL device test report/);
    assert.match(written[0]?.[1] ?? "", /- electron-cast: 9\.9\.9-test/);
    const link = out.find((l) => l.startsWith("https://github.com/adammpkins/electron-cast/issues/new?title="));
    assert.ok(link !== undefined && link.length <= 7000);
    assert.equal(new URL(link).searchParams.get("title"), "DIAL test: Smart TV 9000");
    assert.ok(out.some((l) => l.startsWith("Read it before you post it.")));
    assertScrubbed(out.join("\n"));
  });
});

test("the command's help, version and mistakes", async () => {
  const run = async (argv: string[]): Promise<{ code: number; out: string }> => {
    const out: string[] = [];
    const code = await runCli({
      argv, cwd: ".", libraryVersion: "1.2.3", out: (l) => out.push(l), err: (l) => out.push(l), ask: () => Promise.resolve(null),
    });
    return { code, out: out.join("\n") };
  };
  const help = await run(["dial-test", "--help"]);
  assert.equal(help.code, 0);
  assert.match(help.out, /Asks whether to open YouTube on the TV\. Only if you say yes/);
  assert.equal((await run(["--version"])).out, "1.2.3");
  assert.equal((await run([])).code, 2);
  assert.equal((await run(["dial-test", "--nope"])).code, 2);
  assert.equal((await run(["dial-test", "--device", "x"])).code, 2);
  assert.equal((await run(["frobnicate"])).code, 2);
});
