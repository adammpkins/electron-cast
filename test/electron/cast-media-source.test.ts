// CastMediaSource::FromMediaSourceId (cast_media_source.cc), ported in src/electron/cast-media-source.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CAST_DEVICE_CAPABILITY, chooseAppInfo, parseCastMediaSource, sinkSupportsApp, unescapeUrlComponent,
} from "../../src/electron/cast-media-source.ts";
import { parsePresentationUrl } from "../../src/electron/presentation-envelope.ts";
import { presentationUrlForDevice } from "../../src/electron/manager-api.ts";
import { device } from "./fakes.ts";

const legacy = (...pairs: string[]): string => `https://google.com/cast#${pairs.join("/")}`;

test("a cast: URL reads every parameter Chrome reads", () => {
  const url = "cast:CC1AD845?capabilities=video_out,audio_out,bogus,&clientId=c%201&autoJoinPolicy=origin_scoped"
    + "&defaultActionPolicy=cast_this_tab&launchTimeout=30000&streamingTargetPlayoutDelayMillis=250&streamingCaptureAudio=0"
    + "&supportedAppTypes=ANDROID_TV,WEB,nope&appParams=%7B%22a%22%3A1%7D&invisibleSender=true";
  assert.deepEqual(parseCastMediaSource(url), {
    appInfos: [{ appId: "CC1AD845", requiredCapabilities: 1 | 4, capabilities: ["video_out", "audio_out"] }],
    autoJoinPolicy: "origin_scoped",
    defaultActionPolicy: "cast_this_tab",
    clientId: "c 1",
    launchTimeout: 30000,
    targetPlayoutDelayMillis: 250,
    siteRequestedAudioCapture: false,
    supportedAppTypes: ["ANDROID_TV", "WEB"],
    appParams: '{"a":1}',
    connectionType: "invisible",
  });
});

test("defaults are Chrome's: page_scoped, create_session, WEB, strong, audio capture on", () => {
  const s = parseCastMediaSource("cast:CC1AD845")!;
  assert.equal(s.autoJoinPolicy, "page_scoped");
  assert.equal(s.defaultActionPolicy, "create_session");
  assert.deepEqual(s.supportedAppTypes, ["WEB"]);
  assert.equal(s.connectionType, "strong");
  assert.equal(s.siteRequestedAudioCapture, true);
  assert.equal(s.appParams, "");
  assert.equal(s.clientId, null);
  assert.equal(s.launchTimeout, null);
  assert.equal(s.targetPlayoutDelayMillis, null);
});

test("unknown policy names fall back to the defaults, and invisibleSender is true only for 'true'", () => {
  const s = parseCastMediaSource("cast:A?autoJoinPolicy=everywhere&defaultActionPolicy=nope&invisibleSender=1&supportedAppTypes=nope")!;
  assert.equal(s.autoJoinPolicy, "page_scoped");
  assert.equal(s.defaultActionPolicy, "create_session");
  assert.equal(s.connectionType, "strong");
  assert.deepEqual(s.supportedAppTypes, ["WEB"]);
});

test("numbers follow base::StringToInt: positive, whole, within int32", () => {
  const timeout = (v: string): number | null => parseCastMediaSource(`cast:A?launchTimeout=${v}`)!.launchTimeout;
  assert.equal(timeout("5000"), 5000);
  assert.equal(timeout("%2B5000"), 5000);
  assert.equal(timeout("+5000"), null, "a + in a query is a space, which StringToInt refuses");
  assert.equal(timeout("0"), null);
  assert.equal(timeout("-1"), null);
  assert.equal(timeout("1.5"), null);
  assert.equal(timeout("12ab"), null);
  assert.equal(timeout("2147483647"), 2147483647);
  assert.equal(timeout("2147483648"), null);
  assert.equal(parseCastMediaSource("cast:A?streamingTargetPlayoutDelayMillis=0")!.targetPlayoutDelayMillis, null);
});

test("streamingCaptureAudio turns capture off only for '0'", () => {
  assert.equal(parseCastMediaSource("cast:A?streamingCaptureAudio=1")!.siteRequestedAudioCapture, true);
  assert.equal(parseCastMediaSource("cast:A?streamingCaptureAudio=")!.siteRequestedAudioCapture, true);
  assert.equal(parseCastMediaSource("cast:A?streamingCaptureAudio=0")!.siteRequestedAudioCapture, false);
});

test("a repeated query key takes its last value; '+' is a space and escapes are decoded", () => {
  const s = parseCastMediaSource("cast:A?clientId=one&clientId=t%77o+x")!;
  assert.equal(s.clientId, "two x");
});

test("the app id of a cast: URL is its path, as GURL::GetPath has it: not unescaped, '(caps)' not split", () => {
  assert.equal(parseCastMediaSource("cast:AB%43D")!.appInfos[0]!.appId, "AB%43D");
  const withCaps = parseCastMediaSource("cast:0F5096E8(video_out)")!;
  assert.equal(withCaps.appInfos[0]!.appId, "0F5096E8(video_out)");
  assert.equal(withCaps.appInfos[0]!.requiredCapabilities, 0);
  assert.equal(parseCastMediaSource("cast:"), null);
  assert.equal(parseCastMediaSource("cast:?clientId=1"), null);
});

test("a legacy URL: every __castAppId__ is an app, in order, with its own capabilities", () => {
  const s = parseCastMediaSource(legacy("__castAppId__=AAA(video_out)", "__castAppId__=BBB", "__castAppId__=CCC(audio_out,dev_mode)"))!;
  assert.deepEqual(s.appInfos.map((i) => [i.appId, i.requiredCapabilities]), [
    ["AAA", CAST_DEVICE_CAPABILITY.video_out], ["BBB", 0], ["CCC", CAST_DEVICE_CAPABILITY.audio_out | CAST_DEVICE_CAPABILITY.dev_mode],
  ]);
  assert.equal(parseCastMediaSource(legacy("__castAppId__=", "__castClientId__=1")), null, "an empty app id is skipped, none is left");
});

test("legacy values are unescaped, and the first pair with a key wins", () => {
  const s = parseCastMediaSource(legacy("__castAppId__=%41BC", "__castClientId__=first%20one", "__castClientId__=second",
    "__castAutoJoinPolicy__=origin_scoped", "__castAutoJoinPolicy__=page_scoped", "__castLaunchTimeout__=9000"))!;
  assert.equal(s.appInfos[0]!.appId, "ABC");
  assert.equal(s.clientId, "first one");
  assert.equal(s.autoJoinPolicy, "origin_scoped");
  assert.equal(s.launchTimeout, 9000);
});

test("a legacy URL carries none of the cast: only parameters", () => {
  const s = parseCastMediaSource(legacy("__castAppId__=A", "invisibleSender=true", "appParams=x", "streamingCaptureAudio=0"))!;
  assert.equal(s.connectionType, "strong");
  assert.equal(s.appParams, "");
  assert.equal(s.siteRequestedAudioCapture, true);
});

test("legacy pair splitting: '/' separates pairs, the first '=' splits, '=' runs after it are skipped, bare pairs are kept empty", () => {
  const s = parseCastMediaSource(legacy("__castAppId__==A", "junk", "__castClientId__=a=b", "__castLaunchTimeout__="))!;
  assert.equal(s.appInfos[0]!.appId, "A");
  assert.equal(s.clientId, "a=b");
  assert.equal(s.launchTimeout, null);
});

test("the legacy prefix is matched case-insensitively and only on a valid https URL", () => {
  assert.ok(parseCastMediaSource("HTTPS://GOOGLE.COM/cast#__castAppId__=A"));
  assert.equal(parseCastMediaSource("https://google.com/cast"), null);
  assert.equal(parseCastMediaSource("https://example.test/#__castAppId__=A"), null);
  assert.equal(parseCastMediaSource("http://google.com/cast#__castAppId__=A"), null);
  assert.equal(parseCastMediaSource("not a url"), null);
});

test("a URL over 64 KB is refused, one under it is not", () => {
  assert.equal(parseCastMediaSource("cast:A?appParams=" + "x".repeat(70000)), null);
  assert.ok(parseCastMediaSource("cast:A?appParams=" + "x".repeat(5000)));
});

test("an unclosed capability list reads no capabilities, as ParseLegacyCastUrl does", () => {
  const s = parseCastMediaSource(legacy("__castAppId__=A(video_out"))!;
  assert.equal(s.appInfos[0]!.appId, "A");
  assert.equal(s.appInfos[0]!.requiredCapabilities, 0);
});

test("unescapeUrlComponent keeps control bytes and look-alike characters escaped", () => {
  assert.equal(unescapeUrlComponent("a%20b+c%2Fd%5Ce%25f"), "a b c/d\\e%f");
  assert.equal(unescapeUrlComponent("%00%0a"), "%00%0a");
  assert.equal(unescapeUrlComponent("%C3%A9"), "é");
  assert.equal(unescapeUrlComponent("%E2%80%AE"), "%E2%80%AE", "right-to-left override stays escaped");
  assert.equal(unescapeUrlComponent("%C2%A0"), "%C2%A0", "no-break space stays escaped");
  assert.equal(unescapeUrlComponent("%zz%4"), "%zz%4");
});

test("parsePresentationUrl exposes the same fields, with the first app as appId", () => {
  const p = parsePresentationUrl(legacy("__castAppId__=A(video_out)", "__castAppId__=B"))!;
  assert.equal(p.appId, "A");
  assert.deepEqual(p.capabilities, ["video_out"]);
  assert.equal(p.appInfos.length, 2);
});

test("ChooseAppId: the first app the sink can run, else the first", () => {
  const infos = parseCastMediaSource(legacy("__castAppId__=VID(video_out)", "__castAppId__=AUD(audio_out)", "__castAppId__=ANY"))!.appInfos;
  assert.equal(chooseAppInfo(infos, 1).appId, "VID");
  assert.equal(chooseAppInfo(infos, 4).appId, "AUD");
  assert.equal(chooseAppInfo(infos, 0).appId, "ANY");
  const strict = parseCastMediaSource(legacy("__castAppId__=VID(video_out)", "__castAppId__=AUD(audio_out)"))!.appInfos;
  assert.equal(chooseAppInfo(strict, 0).appId, "VID", "no app fits: the first");
  assert.equal(sinkSupportsApp(5, strict[0]!), true);
});

test("a sink is offered a multi-app URL when one app is available on it and it has that app's capabilities", () => {
  const speaker = device({ id: "spk", capabilities: 4 });
  const tv = device({ id: "tv", capabilities: 5 });
  const url = legacy("__castAppId__=VID(video_out)", "__castAppId__=AUD(audio_out)");
  const available = (apps: string[]) => (_d: unknown, appId: string): boolean => apps.includes(appId);
  assert.equal(presentationUrlForDevice(speaker, [url], available(["VID", "AUD"])), url, "the audio app, though the first needs video");
  assert.equal(presentationUrlForDevice(speaker, [url], available(["VID"])), null, "VID is available but the speaker cannot run it");
  assert.equal(presentationUrlForDevice(tv, [url], available(["AUD"])), url);
  assert.equal(presentationUrlForDevice(tv, [url], available([])), null);
});
