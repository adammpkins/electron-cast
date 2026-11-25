// Acceptance tests for the presentation-mode envelope codec (written before the implementation; do not edit to make
// them pass). Spec: docs/upstream/research/presentation-mode-spec.md, sections 1 and 2.1.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  parsePresentationUrl, stripNulls, escapeHtml, receiverLabel, toReceiver, filterNamespaces, toSession,
  mediaCommands, toMediaEntry, envelope, parseEnvelope, isMediaRequest, receiverMediaType, MEDIA_NAMESPACE,
} from "../../src/electron/presentation-envelope.ts";
import { snapshot } from "../polyfill/harness.ts";

test("parses the legacy google.com/cast URL that Google's sender builds", () => {
  const url = "https://google.com/cast#__castAppId__=CC1AD845/__castClientId__=1732-99/__castAutoJoinPolicy__=origin_scoped"
    + "/__castDefaultActionPolicy__=cast_this_tab/__castLaunchTimeout__=30000";
  assert.deepEqual(parsePresentationUrl(url), {
    appId: "CC1AD845", capabilities: [], clientId: "1732-99", autoJoinPolicy: "origin_scoped",
    defaultActionPolicy: "cast_this_tab", launchTimeout: 30000,
  });
  assert.deepEqual(parsePresentationUrl("https://google.com/cast#__castAppId__=233637DE(video_out,audio_out)"), {
    appId: "233637DE", capabilities: ["video_out", "audio_out"], clientId: null,
    autoJoinPolicy: "tab_and_origin_scoped", defaultActionPolicy: "create_session", launchTimeout: null,
  });
  const dial = "https://google.com/cast#__castAppId__=CC1AD845/__castClientId__=7/__dialAppName__=x/__dialPostData__=YS9iPWM=";
  assert.equal(parsePresentationUrl(dial)?.clientId, "7", "DIAL parameters are ignored");
});

test("parses cast: URLs and rejects everything else", () => {
  assert.deepEqual(parsePresentationUrl("cast:CC1AD845?clientId=5&autoJoinPolicy=page_scoped&capabilities=video_out,audio_out&launchTimeout=5000"), {
    appId: "CC1AD845", capabilities: ["video_out", "audio_out"], clientId: "5", autoJoinPolicy: "page_scoped",
    defaultActionPolicy: "create_session", launchTimeout: 5000,
  });
  assert.equal(parsePresentationUrl("cast:CC1AD845")?.appId, "CC1AD845");
  for (const bad of ["https://example.test/", "https://google.com/cast", "https://google.com/cast#__castClientId__=1",
    "cast:", "not a url", "https://google.com/cast#__castAppId__=" + "A".repeat(70000)]) {
    assert.equal(parsePresentationUrl(bad), null, bad.slice(0, 60));
  }
});

test("stripNulls removes null fields recursively, through arrays of objects", () => {
  assert.deepEqual(stripNulls({ a: null, b: 1, c: { d: null, e: [{ f: null, g: 2 }, 3] }, h: [null, 1] }),
    { b: 1, c: { e: [{ g: 2 }, 3] }, h: [null, 1] });
  assert.equal(stripNulls("x"), "x");
});

test("receiver: hashed label, escaped name, Chromium's shape", () => {
  const token = "t0k3n";
  const label = receiverLabel("device-1", token);
  assert.equal(label, createHash("sha256").update("device-1" + token).digest("base64url"));
  assert.ok(!label.includes("="));
  assert.equal(escapeHtml(`Tom & Jerry's <"TV">`), "Tom &amp; Jerry&#39;s &lt;&quot;TV&quot;&gt;");
  const r = toReceiver({ ...snapshot().receiver, friendlyName: "A & B" }, label);
  assert.deepEqual(r, {
    label, friendlyName: "A &amp; B", capabilities: ["video_out", "audio_out"],
    volume: { level: 0.5, muted: false, controlType: "attenuation", stepInterval: 0.05 },
    isActiveInput: null, displayStatus: null, receiverType: "cast",
  });
});

test("session message: every field clank reads, reserved namespaces filtered except media", () => {
  const ns = [{ name: "urn:x-cast:com.google.cast.tp.heartbeat" }, { name: "urn:x-cast:com.google.cast.receiver" },
    { name: MEDIA_NAMESPACE }, { name: "urn:x-cast:com.google.youtube.mdx" }, { name: "urn:x-cast:com.google.cast.webrtc" }];
  assert.deepEqual(filterNamespaces(ns), [{ name: MEDIA_NAMESPACE }, { name: "urn:x-cast:com.google.youtube.mdx" }]);
  const s = toSession(snapshot({ namespaces: ns }), "L");
  assert.deepEqual(s, {
    sessionId: "session-1", appId: "233637DE", displayName: "YouTube", appImages: [{ url: "https://example.test/icon.png" }],
    receiver: toReceiver(snapshot().receiver, "L"), transportId: "transport-1",
    namespaces: [{ name: MEDIA_NAMESPACE }, { name: "urn:x-cast:com.google.youtube.mdx" }],
    statusText: "YouTube", senderApps: [],
  });
  const withMedia = toSession(snapshot(), "L", [{ mediaSessionId: 1, sessionId: "session-1" }]);
  assert.deepEqual(withMedia.media, [{ mediaSessionId: 1, sessionId: "session-1" }]);
});

test("media entries get the sessionId and string media commands", () => {
  assert.deepEqual(mediaCommands(1 | 2 | 4 | 8 | 64 | 128), ["pause", "seek", "stream_volume", "stream_mute", "queue_next", "queue_prev"]);
  assert.deepEqual(mediaCommands(2), ["seek"]);
  assert.deepEqual(mediaCommands(["pause"]), ["pause"]);
  assert.deepEqual(toMediaEntry({ mediaSessionId: 3, playerState: "PLAYING", supportedMediaCommands: 15 }, "s"),
    { mediaSessionId: 3, playerState: "PLAYING", supportedMediaCommands: ["pause", "seek", "stream_volume", "stream_mute"], sessionId: "s" });
});

test("envelope builds Chromium's router messages", () => {
  assert.deepEqual(JSON.parse(envelope("new_session", { sessionId: "s" }, "c1")),
    { type: "new_session", message: { sessionId: "s" }, timeoutMillis: 0, clientId: "c1" });
  assert.deepEqual(JSON.parse(envelope("app_message", undefined, "c1", 4)),
    { type: "app_message", message: null, sequenceNumber: 4, timeoutMillis: 0, clientId: "c1" });
  assert.deepEqual(JSON.parse(envelope("v2_message", {}, "c1", 0)),
    { type: "v2_message", message: null, sequenceNumber: 0, timeoutMillis: 0, clientId: "c1" });
  assert.deepEqual(JSON.parse(envelope("leave_session", null, "c1", 2)).message, null);
});

test("parseEnvelope accepts what clank sends and rejects what Chromium rejects", () => {
  const ok = (o: object) => parseEnvelope(JSON.stringify(o));
  assert.deepEqual(ok({ type: "client_connect", message: "c1", sequenceNumber: -1, timeoutMillis: 0, clientId: "c1" }),
    { type: "client_connect", message: "c1", sequenceNumber: -1, clientId: "c1" });
  assert.deepEqual(ok({ type: "leave_session", message: "s1", sequenceNumber: 3, timeoutMillis: 3000, clientId: "c1" }),
    { type: "leave_session", message: "s1", sequenceNumber: 3, clientId: "c1" });
  assert.deepEqual(ok({ type: "v2_message", message: { type: "SEEK", requestId: 0, sessionId: "s1", currentTime: null, resumeState: "PLAYBACK_START" }, sequenceNumber: 5, clientId: "c1" }),
    { type: "v2_message", message: { type: "SEEK", requestId: 0, sessionId: "s1", resumeState: "PLAYBACK_START" }, sequenceNumber: 5, clientId: "c1" });
  assert.equal(ok({ type: "app_message", message: { sessionId: "s1", namespaceName: "urn:x-cast:x", message: { a: 1 } }, clientId: "c1" })?.type, "app_message");
  for (const bad of [
    { type: "client_disconnect", message: "c1", clientId: "c1" },
    { type: "v2_message", message: { type: "PLAY" }, clientId: "c1" },
    { type: "v2_message", message: { sessionId: "s1" }, clientId: "c1" },
    { type: "app_message", message: { sessionId: "s1", message: "x" }, clientId: "c1" },
    { type: "leave_session", message: "s1", clientId: "" },
    { type: "leave_session", message: 5, clientId: "c1" },
    { message: "x", clientId: "c1" },
  ]) assert.equal(ok(bad), null, JSON.stringify(bad));
  assert.equal(parseEnvelope("{not json"), null);
});

test("media request types and their receiver names", () => {
  for (const t of ["LOAD", "QUEUE_LOAD", "MEDIA_GET_STATUS", "PLAY", "PAUSE", "SEEK", "STOP_MEDIA", "MEDIA_SET_VOLUME",
    "EDIT_TRACKS_INFO", "QUEUE_INSERT", "QUEUE_UPDATE", "QUEUE_REMOVE", "QUEUE_REORDER"]) assert.ok(isMediaRequest(t), t);
  for (const t of ["SET_VOLUME", "STOP", "LAUNCH", "GET_STATUS_X"]) assert.ok(!isMediaRequest(t), t);
  assert.equal(receiverMediaType("STOP_MEDIA"), "STOP");
  assert.equal(receiverMediaType("MEDIA_SET_VOLUME"), "SET_VOLUME");
  assert.equal(receiverMediaType("MEDIA_GET_STATUS"), "GET_STATUS");
  assert.equal(receiverMediaType("SEEK"), "SEEK");
});
