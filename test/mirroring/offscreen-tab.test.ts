// The offscreen tab of Chrome's 1-UA mode, the parts that need no Electron (its size, `GetCaptureResolutionConstraint`,
// is tested with the other mirroring settings in clamp-flags.test.ts): when it destroys itself
// (`OffscreenTab::DieIfContentCaptureEnded`), and what a presentation URL is as a mirroring source
// (`CastMediaSource::FromMediaSource`, `MirroringActivity::GetMirroringType`, `GetRouteDescription`).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CAPTURE_POLL_INTERVAL_MS, MAX_WAIT_FOR_CAPTURE_MS, watchCapture,
} from "../../src/mirroring/offscreen-tab.ts";
import { isOffscreenTabSource, offscreenTabSourceFor, routeDescription, sessionTypeFor, sinkSupportsSource } from "../../src/mirroring/routing.ts";

/** Timers the test runs by hand. */
function clock() {
  let now = 0;
  let pending: (() => void) | undefined;
  return {
    now: () => now,
    setTimeout: (cb: () => void, ms: number) => {
      assert.equal(ms, CAPTURE_POLL_INTERVAL_MS);
      pending = cb;
      return () => { pending = undefined; };
    },
    /** One poll later. */
    step(): boolean {
      const cb = pending;
      pending = undefined;
      if (cb === undefined) return false;
      now += CAPTURE_POLL_INTERVAL_MS;
      cb();
      return true;
    },
  };
}

test("DieIfContentCaptureEnded: the tab dies once a capture that was seen is gone", () => {
  const c = clock();
  let captured = false;
  const reasons: string[] = [];
  watchCapture({ isBeingCaptured: () => captured, destroy: (r) => reasons.push(r), setTimeout: c.setTimeout, now: c.now });
  c.step();
  captured = true;
  c.step();
  c.step();
  assert.deepEqual(reasons, [], "captured: it lives");
  captured = false;
  c.step();
  assert.deepEqual(reasons, ["capture_ended"]);
  assert.equal(c.step(), false, "and no longer polls");
});

test("DieIfContentCaptureEnded: a tab nobody captures dies after kMaxWaitForCapture, not before", () => {
  const c = clock();
  const reasons: string[] = [];
  watchCapture({ isBeingCaptured: () => false, destroy: (r) => reasons.push(r), setTimeout: c.setTimeout, now: c.now });
  for (let t = 0; t < MAX_WAIT_FOR_CAPTURE_MS; t += CAPTURE_POLL_INTERVAL_MS) c.step();
  assert.deepEqual(reasons, [], "exactly a minute is not past it");
  c.step();
  assert.deepEqual(reasons, ["capture_never_started"]);
});

test("DieIfContentCaptureEnded: stopping the watch ends the polling, and a capture that started late is still watched", () => {
  const c = clock();
  let captured = false;
  const reasons: string[] = [];
  const stop = watchCapture({ isBeingCaptured: () => captured, destroy: (r) => reasons.push(r), setTimeout: c.setTimeout, now: c.now });
  for (let i = 0; i < 59; i++) c.step();
  captured = true;
  for (let i = 0; i < 100; i++) c.step();
  assert.deepEqual(reasons, [], "a capture seen within the minute keeps the tab for as long as it lasts");
  stop();
  captured = false;
  assert.equal(c.step(), false);
  assert.deepEqual(reasons, []);
});

test("CastMediaSource::FromMediaSource: an https URL is a tab mirroring source with the URL as its id", () => {
  const url = "https://example.com/slides?deck=1";
  const source = offscreenTabSourceFor(url)!;
  assert.deepEqual(
    { id: source.id, type: source.type, apps: source.appInfos.map((a) => [a.appId, a.requiredCapabilities]), audio: source.siteRequestedAudioCapture },
    { id: url, type: "offscreen_tab", apps: [["0F5096E8", 5], ["85CDB22F", 4]], audio: true },
  );
  assert.equal(sinkSupportsSource(source, 5), true);
  assert.equal(sinkSupportsSource(source, 4), true, "an audio-only sink runs the audio streaming app");
  assert.equal(sessionTypeFor(source, 5), "audio_video");
  assert.equal(sessionTypeFor(source, 4), "audio_only");
});

test("which URLs are 1-UA sources: https, http on localhost only, not a Cast URL, not an overlong one", () => {
  assert.equal(isOffscreenTabSource("https://example.com/"), true);
  assert.equal(isOffscreenTabSource("http://localhost:8080/receiver.html"), true);
  assert.equal(isOffscreenTabSource("http://127.0.0.1/receiver.html"), true);
  assert.equal(isOffscreenTabSource("http://example.com/"), false, "IsValidPresentationUrl: http only on localhost");
  assert.equal(isOffscreenTabSource("https://google.com/cast#__castAppId__=233637DE"), false, "the legacy Cast form is a Cast app source");
  assert.equal(isOffscreenTabSource("cast:233637DE"), false);
  assert.equal(isOffscreenTabSource("cast-dial:YouTube"), false);
  assert.equal(isOffscreenTabSource("file:///c:/x.html"), false);
  assert.equal(isOffscreenTabSource("not a url"), false);
  assert.equal(isOffscreenTabSource(`https://example.com/?q=${"a".repeat(64 * 1024)}`), false, "kMaxCastPresentationUrlLength");
  assert.equal(offscreenTabSourceFor("cast:233637DE"), undefined);
});

test("GetRouteDescription: an offscreen tab is `Presenting (<host>)`", () => {
  assert.equal(routeDescription("offscreen_tab", "https://slides.example.com:8443/deck/1?x=y"), "Presenting (slides.example.com)");
  assert.equal(routeDescription("tab", "anything"), "Casting tab");
  assert.equal(routeDescription("desktop"), "Casting screen");
});
