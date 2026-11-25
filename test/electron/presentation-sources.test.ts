// Mirroring and remote-playback sources. Chrome's Cast provider routes a source naming a Cast Streaming app to a
// MirroringActivity (CastActivityManager::DoLaunchSession, CastMediaSource::ContainsStreamingApp) and serves
// remote-playback: sources by media remoting; electron-cast has neither, so they must never launch as ordinary apps.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CAST_STREAMING_APP_IDS, castUrlAppIds, chooseSource, classifyPresentationUrl, containsStreamingApp,
} from "../../src/electron/presentation-source.ts";
import { CastSessionService, type CastRequestInfo, type DeviceChoice } from "../../src/electron/session-service.ts";
import { CastPresentationHandler } from "../../src/electron/presentation-handler.ts";
import type { CastDevice } from "../../src/discovery/index.ts";
import { FakeDevices, FakeClient, TV, tick, FAST_SINKS, waitForSinks } from "./fakes.ts";

const YT = "233637DE";
const AV = "0F5096E8";
const AUDIO = "85CDB22F";
const legacy = (...apps: string[]) => `https://google.com/cast#${apps.map((a) => `__castAppId__=${a}`).join("/")}/__castClientId__=c1`;
const REMOTE = "remote-playback:media-element?source=aHR0cHM6Ly9leGFtcGxlLnRlc3Qvdi5tcDQ=&video_codec=h264";

test("the streaming app ids are the two Chromium lists (audio and video, audio only)", () => {
  assert.deepEqual([...CAST_STREAMING_APP_IDS], ["0F5096E8", "85CDB22F"]);
});

test("cast: and legacy URLs naming a streaming app are mirroring sources", () => {
  assert.equal(classifyPresentationUrl(`cast:${AV}`), "mirroring");
  assert.equal(classifyPresentationUrl(`cast:${AUDIO}?streamingCaptureAudio=0`), "mirroring");
  assert.equal(classifyPresentationUrl(legacy(AV)), "mirroring");
  assert.equal(classifyPresentationUrl(legacy(AUDIO)), "mirroring");
  assert.equal(classifyPresentationUrl(`cast:${YT}?clientId=c1`), "cast_app");
  assert.equal(classifyPresentationUrl(legacy(YT)), "cast_app");
});

test("one legacy URL listing several apps is a mirroring source when any of them streams", () => {
  // CastMediaSource::ContainsStreamingApp looks at every app info, and the whole source is then routed to mirroring
  assert.deepEqual(castUrlAppIds(legacy(YT, AV)), [YT, AV]);
  assert.equal(classifyPresentationUrl(legacy(YT, AV)), "mirroring");
  assert.equal(classifyPresentationUrl(legacy(AV, YT)), "mirroring");
  assert.equal(classifyPresentationUrl(legacy(YT, "CC1AD845")), "cast_app");
});

test("capability suffixes and escapes do not hide a streaming app", () => {
  assert.deepEqual(castUrlAppIds(legacy(`${AV}(video_out,audio_out)`)), [AV]);
  assert.equal(classifyPresentationUrl(legacy(`${AV}(video_out)`)), "mirroring");
  assert.equal(classifyPresentationUrl(`https://google.com/cast#__castAppId__=%30F5096E8`), "mirroring");
  assert.equal(containsStreamingApp(`cast:${AV}(video_out)`), true);
});

test("the app id comparison is exact, as CastMediaSource::ContainsApp is", () => {
  assert.equal(classifyPresentationUrl(`cast:${AV.toLowerCase()}`), "cast_app");
});

test("remote-playback: is its own kind, other URLs are not served", () => {
  assert.equal(classifyPresentationUrl(REMOTE), "remote_playback");
  assert.equal(classifyPresentationUrl("https://example.test/"), "other");
  assert.equal(classifyPresentationUrl("not a url"), "other");
  assert.equal(classifyPresentationUrl("cast:"), "other");
  assert.equal(classifyPresentationUrl("https://google.com/cast#__castClientId__=c1"), "other");
});

test("chooseSource serves the first ordinary Cast URL and is not blocked by mirroring or remoting entries", () => {
  assert.deepEqual(chooseSource([`cast:${AV}`, `cast:${YT}`]), { kind: "launch", url: `cast:${YT}`, parsed: chooseSourceParsed(`cast:${YT}`) });
  assert.equal(chooseSource([REMOTE, legacy(AV), legacy(YT)]).kind, "launch");
  assert.equal(chooseSource([legacy(YT, AV), legacy(AV), legacy(YT)]).kind, "launch");
  assert.equal((chooseSource([legacy(YT, AV), legacy(YT)]) as { url: string }).url, legacy(YT));
});

function chooseSourceParsed(url: string) {
  const c = chooseSource([url]);
  assert.equal(c.kind, "launch");
  return (c as { parsed: unknown }).parsed as never;
}

test("chooseSource reports no sink when only mirroring or remoting sources are left, unsupported when none is valid", () => {
  assert.equal(chooseSource([`cast:${AV}`]).kind, "no_sink");
  assert.equal(chooseSource([REMOTE]).kind, "no_sink");
  assert.equal(chooseSource([legacy(YT, AUDIO), REMOTE]).kind, "no_sink");
  assert.equal(chooseSource(["https://example.test/"]).kind, "unsupported");
  assert.equal(chooseSource([]).kind, "unsupported");
});

test("cast-dial: is the DIAL kind; with DIAL on it is served next to a Cast URL or alone, with DIAL off it is not", () => {
  const DIAL = "cast-dial:YouTube?clientId=c1";
  assert.equal(classifyPresentationUrl(DIAL), "dial");
  assert.deepEqual(chooseSource([DIAL, `cast:${YT}`], { dial: true }), {
    kind: "launch", url: `cast:${YT}`, parsed: chooseSourceParsed(`cast:${YT}`), dial: { url: DIAL, app: "YouTube" },
  });
  assert.deepEqual(chooseSource([`cast:${AV}`, DIAL], { dial: true }), { kind: "dial", dial: { url: DIAL, app: "YouTube" } });
  // the first cast-dial: URL naming a valid app is the one
  assert.deepEqual(chooseSource(["cast-dial:", DIAL, "cast-dial:Netflix"], { dial: true }), { kind: "dial", dial: { url: DIAL, app: "YouTube" } });
  assert.equal(chooseSource([DIAL]).kind, "unsupported");
  assert.equal(chooseSource([DIAL, `cast:${AV}`]).kind, "no_sink");
});

// The handler, on the real session service with fakes.
function setup(o: { pick?: (l: CastDevice[], r: CastRequestInfo) => DeviceChoice } = {}) {
  const devices = new FakeDevices();
  const clients: FakeClient[] = [];
  const launched: string[] = [];
  // The devices are offered once their channels are open; calls wait for that
  const service = waitForSinks(new CastSessionService({
    sinks: FAST_SINKS,
    devices,
    createClient: (d) => {
      const c = new FakeClient(d);
      const launch = c.launch.bind(c);
      c.launch = async (id: string) => {
        launched.push(id);
        return launch(id);
      };
      clients.push(c);
      return c;
    },
    selectDevice: async (list, r) => (o.pick ? o.pick(list, r) : (list.find((d) => d.id === TV.id) ?? null)),
    emit: () => {},
  }));
  const handler = new CastPresentationHandler({ service, token: "tok" });
  return { handler, launched, devices };
}
const req = (...urls: string[]) => ({ urls, origin: "https://docs.google.com", senderId: 1 });
const avail = (h: ReturnType<typeof setup>, ...urls: string[]) =>
  h.handler.getAvailability({ ...req(...urls), onchange: () => {}, signal: new AbortController().signal });

test("a mirroring or remote-playback source is unavailable even with devices, for any origin", async () => {
  const h = setup();
  assert.equal(await avail(h, legacy(YT)), true);
  assert.equal(await avail(h, `cast:${AV}`), false);
  assert.equal(await avail(h, legacy(AUDIO)), false);
  assert.equal(await avail(h, legacy(YT, AV)), false);
  assert.equal(await avail(h, REMOTE), false);
  assert.deepEqual(h.launched, []);
});

test("availability of a list is that of its best URL: a normal app next to a mirroring one still casts", async () => {
  const h = setup();
  assert.equal(await avail(h, legacy(AV), legacy(YT)), true);
  assert.equal(await avail(h, REMOTE, `cast:${YT}`), true);
});

test("start never launches a streaming app, and says what Chrome says when no screen serves the request", async () => {
  const h = setup();
  for (const url of [`cast:${AV}`, legacy(AUDIO), legacy(YT, AV), REMOTE]) {
    await assert.rejects(h.handler.startPresentation(req(url)), { name: "NotFoundError", message: "No screens found." });
  }
  await tick();
  assert.deepEqual(h.launched, [], "nothing was launched on the device");
});

test("start with a normal app listed after a mirroring one launches the normal app", async () => {
  const h = setup();
  const conn = await h.handler.startPresentation(req(legacy(AV), REMOTE, legacy(YT)));
  assert.equal(conn.url, legacy(YT));
  assert.deepEqual(h.launched, [YT]);
});

test("reconnect to a mirroring source finds no route and does not touch the device", async () => {
  const h = setup();
  await assert.rejects(h.handler.reconnectPresentation({ ...req(`cast:${AV}`), presentationId: "auto-join" }), { name: "NotFoundError" });
  assert.deepEqual(h.launched, []);
});
