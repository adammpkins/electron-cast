// v2_message requests: which types are forwarded to the receiver and which are dropped, matching Chromium's
// CastSessionClientImpl::HandleV2ProtocolMessage and IsMediaRequestMessageType.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CastSessionService } from "../../src/electron/session-service.ts";
import { CastPresentationHandler, type PresentationConnectionHandle } from "../../src/electron/presentation-handler.ts";
import { MEDIA_NAMESPACE, isMediaRequest, receiverMediaType } from "../../src/electron/presentation-envelope.ts";
import { FakeDevices, FakeClient, TV, tick } from "./fakes.ts";

const URL_O = "https://google.com/cast#__castAppId__=233637DE/__castClientId__=c1/__castAutoJoinPolicy__=origin_scoped";
const PAGE = { id: 1, origin: "https://music.youtube.com" };

async function started() {
  const clients: FakeClient[] = [];
  let handler: CastPresentationHandler | undefined;
  const service = new CastSessionService({
    devices: new FakeDevices(),
    createClient: (d) => {
      const c = new FakeClient(d);
      const launch = c.launch.bind(c);
      c.launch = async (id: string) => {
        const app = await launch(id);
        app.namespaces.push({ name: MEDIA_NAMESPACE });
        return app;
      };
      clients.push(c);
      return c;
    },
    selectDevice: async (list) => list.find((d) => d.id === TV.id) ?? null,
    emit: (id, ev) => handler?.onServiceEvent(id, ev),
  });
  handler = new CastPresentationHandler({ service, token: "tok" });
  const conn: PresentationConnectionHandle = await handler.startPresentation({ urls: [URL_O], origin: PAGE.origin, senderId: PAGE.id });
  const got: any[] = [];
  conn.onmessage = (data: string) => got.push(JSON.parse(data));
  conn.onclose = () => {};
  const sid = got.find((m) => m.type === "new_session").message.sessionId as string;
  return { conn, got, sid, client: clients[0]! };
}

test("queue navigation and precache are media requests, like Chromium", () => {
  for (const t of ["QUEUE_NEXT", "QUEUE_PREV", "PRECACHE"]) {
    assert.ok(isMediaRequest(t), t);
    assert.equal(receiverMediaType(t), t);
  }
});

for (const type of ["QUEUE_NEXT", "QUEUE_PREV", "PRECACHE"]) {
  test(`${type} reaches the receiver and its reply maps back to the sequence number`, async () => {
    const { conn, got, sid, client } = await started();
    conn.send(JSON.stringify({ type: "v2_message", message: { type, requestId: 0, sessionId: sid, mediaSessionId: 1 }, sequenceNumber: 21, timeoutMillis: 0, clientId: "c1" }));
    await tick();
    const sent = JSON.parse(client.sent.at(-1)!.payload as string);
    assert.equal(sent.type, type);
    assert.ok(Number.isInteger(sent.requestId) && sent.requestId > 0);
    client.pushMessage(client.sent.at(-1)!.destinationId, MEDIA_NAMESPACE, JSON.stringify({ type: "MEDIA_STATUS", requestId: sent.requestId, status: [{ mediaSessionId: 1, playerState: "PLAYING" }] }));
    await tick();
    assert.equal(got.at(-1).type, "v2_message");
    assert.equal(got.at(-1).sequenceNumber, 21);
  });
}

test("an unknown v2_message type is dropped: nothing reaches the receiver and no reply is sent", async () => {
  const { conn, got, sid, client } = await started();
  const before = { sent: client.sent.length, got: got.length };
  for (const type of ["LAUNCH", "GET_STATUS", "NOT_A_REAL_TYPE"]) {
    conn.send(JSON.stringify({ type: "v2_message", message: { type, requestId: 0, sessionId: sid }, sequenceNumber: 30, timeoutMillis: 0, clientId: "c1" }));
  }
  await tick();
  assert.equal(client.sent.length, before.sent);
  assert.equal(got.length, before.got);
});

test("a failed SET_VOLUME reports internal_error 'unknown error', like Chromium's SendResultResponse", async () => {
  const { conn, got, sid, client } = await started();
  client.setVolume = async () => {
    throw new Error("boom");
  };
  conn.send(JSON.stringify({ type: "v2_message", message: { type: "SET_VOLUME", requestId: 0, sessionId: sid, volume: { level: 0.5 } }, sequenceNumber: 40, timeoutMillis: 0, clientId: "c1" }));
  await tick();
  assert.deepEqual(got.at(-1), {
    type: "error", message: { code: "internal_error", description: "unknown error", details: null },
    sequenceNumber: 40, timeoutMillis: 0, clientId: "c1",
  });
});

test("a media request that cannot be sent gets no reply, like Chromium", async () => {
  const { conn, got, sid, client } = await started();
  const n = got.length;
  client.send = () => {
    throw new Error("channel down");
  };
  conn.send(JSON.stringify({ type: "v2_message", message: { type: "PLAY", requestId: 0, sessionId: sid, mediaSessionId: 1 }, sequenceNumber: 41, timeoutMillis: 0, clientId: "c1" }));
  await tick();
  assert.equal(got.length, n);
});
