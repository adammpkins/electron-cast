// The tracker keeps each device's session from its receiver status, as Chrome's CastSession::From and CastSessionTracker do.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CastSessionTracker, sessionFromStatus } from "../../src/electron/session-tracker.ts";
import type { ReceiverApplication } from "../../src/client/index.ts";
import { FakeClient, TV, SPEAKER, tick } from "./fakes.ts";

const MEDIA = "urn:x-cast:com.google.cast.media";
const app = (over: Partial<ReceiverApplication> = {}): ReceiverApplication => ({
  appId: "233637DE",
  displayName: "YouTube",
  sessionId: "s1",
  transportId: "t1",
  statusText: "YouTube",
  namespaces: [{ name: "urn:x-cast:com.google.youtube.mdx" }, { name: MEDIA }, { name: "urn:x-cast:com.google.cast.receiver" }],
  ...over,
});
const status = (...apps: ReceiverApplication[]) => ({ applications: apps, volume: { level: 0.5, muted: false } });

test("CastSession::From: exactly one application with ids, a name and namespaces; reserved namespaces are dropped, media kept", () => {
  const s = sessionFromStatus("dev-tv", status(app()));
  assert.deepEqual([s?.sessionId, s?.appId, s?.transportId, s?.displayName, s?.statusText], ["s1", "233637DE", "t1", "YouTube", "YouTube"]);
  assert.deepEqual(s?.namespaces, ["urn:x-cast:com.google.youtube.mdx", MEDIA]);
  assert.equal(sessionFromStatus("d", status()), undefined, "no application");
  assert.equal(sessionFromStatus("d", status(app(), app({ sessionId: "s2" }))), undefined, "two applications");
  assert.equal(sessionFromStatus("d", status(app({ appId: "E8C28D3C" }))), undefined, "the backdrop");
  assert.equal(sessionFromStatus("d", status(app({ transportId: "receiver-0" }))), undefined, "the platform receiver's transport");
  assert.equal(sessionFromStatus("d", status(app({ namespaces: [] }))), undefined, "no namespaces");
  assert.equal(sessionFromStatus("d", status(app({ namespaces: [], appId: "MultizoneLeader" })))?.namespaces.length, 0, "a multizone leader may have none");
  assert.equal(sessionFromStatus("d", status({ ...app(), displayName: undefined as unknown as string })), undefined, "no display name");
  assert.deepEqual(sessionFromStatus("d", status(app({ namespaces: [{ name: "urn:x-cast:com.google.cast.receiverx" }] })))?.namespaces, ["urn:x-cast:com.google.cast.receiverx"], "only a name below a reserved one after a dot is reserved");
});

test("attach asks the device for its status and follows pushed statuses; events fire only on change", async () => {
  const tracker = new CastSessionTracker();
  const client = new FakeClient(TV);
  client.apps = [app()];
  const seen: string[] = [];
  tracker.on("sessionAddedOrUpdated", (s) => seen.push(`${s.sessionId}:${s.statusText}`));
  tracker.on("sessionRemoved", (id, s) => seen.push(`removed ${id} ${s.sessionId}`));
  tracker.attach(TV.id, client);
  await tick(1);
  assert.deepEqual(seen, ["s1:YouTube"]);
  client.pushStatus();
  assert.deepEqual(seen, ["s1:YouTube"], "the same status again says nothing");
  client.apps = [app({ statusText: "Playing" })];
  client.pushStatus();
  assert.deepEqual(seen.at(-1), "s1:Playing");
  client.apps = [];
  client.pushStatus();
  assert.deepEqual(seen.at(-1), "removed dev-tv s1");
  assert.equal(tracker.sessionOf(TV.id), undefined);
});

test("a different session on the device replaces the old one instead of keeping its id", async () => {
  const tracker = new CastSessionTracker();
  const client = new FakeClient(TV);
  client.apps = [app()];
  tracker.attach(TV.id, client);
  await tick(1);
  client.apps = [app({ sessionId: "s2", transportId: "t2", appId: "CC1AD845" })];
  client.pushStatus();
  assert.deepEqual([tracker.sessionOf(TV.id)?.sessionId, tracker.sessionOf(TV.id)?.appId], ["s2", "CC1AD845"]);
  assert.equal(tracker.sessionById("s1"), undefined);
  assert.equal(tracker.sessionById("s2")?.sinkId, TV.id);
});

test("MEDIA_STATUS entries are merged by mediaSessionId and carry the session's id", async () => {
  const tracker = new CastSessionTracker();
  const client = new FakeClient(TV);
  client.apps = [app()];
  tracker.attach(TV.id, client);
  await tick(1);
  let updates = 0;
  tracker.on("sessionAddedOrUpdated", () => updates++);
  const send = (entries: unknown[]) => client.pushMessage("t1", MEDIA, JSON.stringify({ type: "MEDIA_STATUS", status: entries }));
  send([{ mediaSessionId: 1, playerState: "PLAYING", media: { contentId: "a" } }]);
  assert.deepEqual(tracker.sessionOf(TV.id)?.media, [{ mediaSessionId: 1, playerState: "PLAYING", media: { contentId: "a" }, sessionId: "s1" }]);
  send([{ mediaSessionId: 1, playerState: "PAUSED" }]);
  assert.deepEqual(tracker.sessionOf(TV.id)?.media[0], { mediaSessionId: 1, playerState: "PAUSED", media: { contentId: "a" }, sessionId: "s1" }, "fields the update lacks are kept");
  assert.equal(updates, 2);
  send([{ mediaSessionId: 1, playerState: "PAUSED" }]);
  assert.equal(updates, 2, "no change, no event");
  client.pushMessage("t1", MEDIA, "not json");
  client.pushMessage("t1", "urn:x-cast:com.google.youtube.mdx", JSON.stringify({ type: "MEDIA_STATUS", status: [{ mediaSessionId: 9 }] }));
  assert.equal(updates, 2, "other namespaces and bad data are ignored");
});

test("a replaced channel's late events are ignored, and removing a sink drops its session", async () => {
  const tracker = new CastSessionTracker();
  const old = new FakeClient(TV);
  old.apps = [app()];
  tracker.attach(TV.id, old);
  await tick(1);
  const fresh = new FakeClient(TV);
  fresh.apps = [app({ sessionId: "s9", transportId: "t9" })];
  tracker.attach(TV.id, fresh);
  await tick(1);
  old.apps = [];
  old.pushStatus();
  assert.equal(tracker.sessionOf(TV.id)?.sessionId, "s9", "the old client no longer speaks for the device");
  const other = new FakeClient(SPEAKER);
  other.apps = [app({ sessionId: "sp" })];
  tracker.attach(SPEAKER.id, other);
  await tick(1);
  assert.equal(tracker.sessions().length, 2);
  let removed = 0;
  tracker.on("sessionRemoved", () => removed++);
  tracker.removeSink(TV.id);
  assert.equal(removed, 1);
  assert.deepEqual(tracker.sessions().map((s) => s.sinkId), [SPEAKER.id]);
  tracker.dispose();
  assert.deepEqual(tracker.sessions(), []);
});

test("a device whose status request fails is not an error for the tracker", async () => {
  const tracker = new CastSessionTracker();
  const client = new FakeClient(TV);
  client.getStatus = async () => { throw new Error("closed"); };
  tracker.attach(TV.id, client);
  await tick(1);
  assert.deepEqual(tracker.sessions(), []);
});

test("every status and media status is reported to the observers, changed or not, backfilled as HandleMediaStatusMessage does", async () => {
  const tracker = new CastSessionTracker();
  const client = new FakeClient(TV);
  client.apps = [app()];
  tracker.attach(TV.id, client);
  await tick(1);
  const statuses: string[] = [];
  const medias: Record<string, unknown>[] = [];
  tracker.on("sessionStatus", (s) => statuses.push(s.sessionId));
  tracker.on("mediaStatus", (_s, m) => medias.push(m));
  client.pushStatus();
  client.pushStatus();
  assert.deepEqual(statuses, ["s1", "s1"], "OnSessionAddedOrUpdated for each RECEIVER_STATUS");
  // a status reply fed in by a caller is not counted again (the channel already reported it as a status message)
  tracker.applyStatus(TV.id, client, await client.getStatus());
  assert.deepEqual(statuses, ["s1", "s1"]);
  const send = (entries: unknown[]) => client.pushMessage("t1", MEDIA, JSON.stringify({ type: "MEDIA_STATUS", requestId: 5, status: entries }));
  send([{ mediaSessionId: 1, supportedMediaCommands: 1 | 2 | 4 | 8 | 64 | 128, media: { contentId: "a" } }, 7]);
  send([{ mediaSessionId: 1, playerState: "PAUSED" }]);
  send([{ mediaSessionId: 1, playerState: "PAUSED" }]);
  assert.equal(medias.length, 3, "OnMediaStatusUpdated for each MEDIA_STATUS");
  assert.deepEqual(medias[0], {
    type: "MEDIA_STATUS", requestId: 5, sessionId: "s1",
    status: [{ mediaSessionId: 1, supportedMediaCommands: ["pause", "seek", "stream_volume", "stream_mute", "queue_next", "queue_prev"], media: { contentId: "a" }, sessionId: "s1" }],
  });
  assert.deepEqual((medias[2]!.status as unknown[])[0], {
    mediaSessionId: 1, playerState: "PAUSED", sessionId: "s1",
    supportedMediaCommands: ["pause", "seek", "stream_volume", "stream_mute", "queue_next", "queue_prev"], media: { contentId: "a" },
  });
  client.apps = [];
  client.pushStatus();
  send([{ mediaSessionId: 1 }]);
  assert.deepEqual([statuses.length, medias.length], [2, 3], "nothing once the device runs no session");
});
