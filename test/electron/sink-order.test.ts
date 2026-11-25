// MediaSink::CompareUsingCollator (media_sink.cc) and GetReceiverIdHashToken (media_router_feature.cc).
import { test } from "node:test";
import assert from "node:assert/strict";
import { sinkLess, sortSinks, sortDevicesAsSinks, castIconType } from "../../src/electron/sink-order.ts";
import { getReceiverIdHashToken } from "../../src/electron/receiver-id-token.ts";
import { device } from "./fakes.ts";

const sink = (id: string, name: string, iconType: "cast" | "cast_audio" | "cast_audio_group" | "generic" | "wired_display") => ({ id, name, iconType });

test("sinks sort by icon type, then collated name, then id", () => {
  const sorted = sortSinks([
    sink("g", "Generic", "generic"),
    sink("a2", "Audio", "cast_audio"),
    sink("w", "Display 1", "wired_display"),
    sink("grp", "Zed group", "cast_audio_group"),
    sink("b", "bravo", "cast"),
    sink("a", "Alpha", "cast"),
    sink("c2", "Charlie", "cast"),
    sink("c1", "Charlie", "cast"),
  ]);
  assert.deepEqual(sorted.map((s) => s.id), ["a", "b", "c1", "c2", "grp", "a2", "w", "g"]);
});

test("the name is collated, not compared by code unit: 'bravo' is before 'Charlie', and accents sort with their letter", () => {
  assert.equal(sinkLess(sink("1", "bravo", "cast"), sink("2", "Charlie", "cast"), new Intl.Collator("en")), true);
  assert.equal(sinkLess(sink("1", "éclair", "cast"), sink("2", "Zebra", "cast"), new Intl.Collator("en")), true);
  // the no-collator fallback is a plain comparison, where uppercase sorts first
  assert.equal(sinkLess(sink("1", "bravo", "cast"), sink("2", "Charlie", "cast"), null), false);
});

test("the icon type follows the capabilities, and devices sort as their sinks do", () => {
  assert.equal(castIconType(1), "cast");
  assert.equal(castIconType(4 | 32), "cast_audio_group");
  assert.equal(castIconType(4), "cast_audio");
  const speaker = device({ id: "s", name: "A speaker", capabilities: 4 });
  const tv = device({ id: "t", name: "Z tv", capabilities: 5 });
  assert.deepEqual(sortDevicesAsSinks([speaker, tv]).map((d) => d.id), ["t", "s"]);
});

test("the receiver id hash token is 64 random bytes in base64, saved once and read back", () => {
  let saved: string | undefined;
  let saves = 0;
  const store = { load: () => saved, save: (t: string) => { saved = t; saves++; } };
  const first = getReceiverIdHashToken(store);
  assert.equal(Buffer.from(first, "base64").length, 64);
  assert.equal(getReceiverIdHashToken(store), first);
  assert.equal(saves, 1);
  assert.notEqual(getReceiverIdHashToken(), first, "without a store a token is made each time");
});

test("a store that throws does not stop the token", () => {
  const broken = { load: (): string => { throw new Error("no"); }, save: (): void => { throw new Error("no"); } };
  assert.equal(Buffer.from(getReceiverIdHashToken(broken), "base64").length, 64);
});

test("an empty saved token is replaced", () => {
  let saved = "";
  const token = getReceiverIdHashToken({ load: () => saved, save: (t) => void (saved = t) });
  assert.equal(saved, token);
  assert.notEqual(token, "");
});
