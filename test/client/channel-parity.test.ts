import { test, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { CastClient, CastConnectionError, CastLaunchError, CastTimeoutError } from "../../src/client/index.ts";
import { chromeSenderIdentity } from "../../src/client/sender-info.ts";
import { FakeReceiver, NS_CONNECTION, NS_HEARTBEAT, NS_RECEIVER } from "./fake-receiver.ts";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

const SENDER = {
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
  browserVersion: "138.0.7204.100",
  locale: "de-DE",
  platform: 3,
};

async function setup(opts: Partial<ConstructorParameters<typeof CastClient>[0]> = {}) {
  const fake = new FakeReceiver();
  const port = await fake.listen();
  const client = new CastClient({ host: "127.0.0.1", port, verifyDevice: false, sender: SENDER, ...opts });
  cleanups.push(() => fake.close(), () => client.close());
  return { fake, client };
}

/** Lets real I/O run until `cond` holds, without the timers a test may have mocked. */
async function until(cond: () => boolean, what: string): Promise<void> {
  const start = performance.now();
  while (!cond()) {
    if (performance.now() - start > 5000) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setImmediate(r));
  }
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
};

// cast_message_util.cc CreateVirtualConnectionRequest
test("CONNECT to receiver-0 carries userAgent, a strong connType, an empty origin and senderInfo", async () => {
  const { fake, client } = await setup();
  await client.connect();
  const m = await fake.ready();
  assert.deepEqual(m.json, {
    type: "CONNECT",
    userAgent: SENDER.userAgent,
    connType: 0,
    origin: {},
    senderInfo: {
      sdkType: 2,
      version: "138.0.7204.100",
      browserVersion: "138.0.7204.100",
      platform: 3,
      connectionType: 1,
      systemVersion: "Windows NT 10.0; Win64; x64",
    },
  });
});

test("an app transport connects strong, and invisible when the source asks for it", async () => {
  const { fake, client } = await setup();
  await client.connect();
  await fake.ready();
  client.connectTransport("t-strong");
  client.connectTransport("t-invisible", { invisible: true });
  const strong = await fake.waitFor((m) => m.namespace === NS_CONNECTION && m.destinationId === "t-strong");
  const invisible = await fake.waitFor((m) => m.namespace === NS_CONNECTION && m.destinationId === "t-invisible");
  assert.equal(strong.json?.connType, 0);
  assert.equal(invisible.json?.connType, 2);
  assert.deepEqual((invisible.json?.senderInfo as Record<string, unknown>).platform, 3);
});

test("the sender identity is what Chrome builds on each desktop OS (user_agent_utils.cc GetUnifiedPlatform)", () => {
  const win = chromeSenderIdentity("win32", "138.0.7204.100", "en-US");
  assert.equal(win.userAgent, "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36");
  assert.deepEqual([win.platform, win.browserVersion, win.locale], [3, "138.0.7204.100", "en-US"]);
  const mac = chromeSenderIdentity("darwin", "138.0.7204.100", "en-US");
  assert.match(mac.userAgent, /^Mozilla\/5\.0 \(Macintosh; Intel Mac OS X 10_15_7\) /);
  assert.equal(mac.platform, 4);
  const linux = chromeSenderIdentity("linux", "138.0.7204.100", "en-US");
  assert.match(linux.userAgent, /^Mozilla\/5\.0 \(X11; Linux x86_64\) /);
  assert.equal(linux.platform, 6);
});

// cast_message_util.cc CreateLaunchRequest
test("LAUNCH carries language, supportedAppTypes (WEB by default) and appParams when given", async () => {
  const { fake, client } = await setup();
  await client.connect();
  await fake.ready();
  await client.launch("APP1");
  await client.launch("APP2", { supportedAppTypes: ["WEB", "ANDROID_TV"], appParams: { query: "x", n: [1] } });
  await client.launch("APP3", { supportedAppTypes: [] });
  const launches = fake.received.filter((m) => m.json?.type === "LAUNCH").map((m) => m.json);
  assert.deepEqual(launches[0], { type: "LAUNCH", requestId: 1, appId: "APP1", language: "de-DE", supportedAppTypes: ["WEB"] });
  assert.deepEqual(launches[1], {
    type: "LAUNCH", requestId: 2, appId: "APP2", language: "de-DE", supportedAppTypes: ["WEB", "ANDROID_TV"], appParams: { query: "x", n: [1] },
  });
  assert.deepEqual(launches[2]?.supportedAppTypes, ["WEB"]);
});

test("LAUNCH_STATUS USER_PENDING_AUTHORIZATION keeps the launch open, USER_ALLOWED too, and the receiver's status ends it", async () => {
  const { fake, client } = await setup();
  fake.autoReply = false;
  await client.connect();
  await fake.ready();
  const seen: string[] = [];
  const launched = client.launch("APP1", { onStatus: (s) => seen.push(s) });
  const request = await fake.waitFor((m) => m.json?.type === "LAUNCH");
  const requestId = request.json?.requestId;
  fake.sendJson(NS_RECEIVER, "receiver-0", client.senderId, { type: "LAUNCH_STATUS", requestId, status: "USER_PENDING_AUTHORIZATION" });
  await until(() => seen.length === 1, "pending status");
  fake.sendJson(NS_RECEIVER, "receiver-0", client.senderId, { type: "LAUNCH_STATUS", requestId: requestId === 99 ? 98 : 99, status: "USER_ALLOWED" });
  await settle();
  assert.deepEqual(seen, ["pending_authorization"], "a status for another request is not this launch's");
  fake.sendJson(NS_RECEIVER, "receiver-0", client.senderId, { type: "LAUNCH_STATUS", requestId, status: "USER_ALLOWED" });
  await until(() => seen.length === 2, "allowed status");
  assert.deepEqual(seen, ["pending_authorization", "allowed"]);
  fake.apps = [{ appId: "APP1", displayName: "A", sessionId: "s1", transportId: "t1", statusText: "", namespaces: [], isIdleScreen: false }];
  fake.send({ namespace: NS_RECEIVER, sourceId: "receiver-0", destinationId: client.senderId, payloadUtf8: JSON.stringify(fake.status(requestId as number)) });
  assert.equal((await launched).sessionId, "s1");
});

// The deadline is driven by mocked timers: with real ones (150 ms) a loaded machine could pass it before the status was sent
test("pending authorization does not extend the launch timeout", async () => {
  mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  try {
    const { fake, client } = await setup({ launchTimeoutMs: 150, heartbeatTimeoutMs: 10_000_000, heartbeatIntervalMs: 10_000_000 });
    fake.autoReply = false;
    await client.connect();
    await until(() => fake.received.some((m) => m.json?.type === "CONNECT"), "CONNECT");
    const seen: string[] = [];
    let outcome = "";
    client.launch("APP1", { onStatus: (s) => seen.push(s) }).catch((e: unknown) => { outcome = e instanceof CastTimeoutError ? "timeout" : String(e); });
    await until(() => fake.received.some((m) => m.json?.type === "LAUNCH"), "LAUNCH");
    const requestId = fake.received.find((m) => m.json?.type === "LAUNCH")?.json?.requestId;
    mock.timers.tick(90);
    fake.sendJson(NS_RECEIVER, "receiver-0", client.senderId, { type: "LAUNCH_STATUS", requestId, status: "USER_PENDING_AUTHORIZATION" });
    await until(() => seen.length === 1, "pending status");
    assert.deepEqual(seen, ["pending_authorization"]);
    mock.timers.tick(59);
    await settle();
    assert.equal(outcome, "", "still waiting at 149 ms");
    mock.timers.tick(1);
    await until(() => outcome !== "", "the launch timeout");
    assert.equal(outcome, "timeout", "it timed out on the original deadline, not 150 ms after the status");
  } finally {
    mock.timers.reset();
  }
});

test("LAUNCH_ERROR extendedError USER_NOT_ALLOWED and USER_NOTIFICATIONS_DISABLED are told apart, as Chrome's results", async () => {
  const { fake, client } = await setup();
  fake.autoReply = false;
  await client.connect();
  await fake.ready();
  const fail = async (reply: Record<string, unknown>): Promise<CastLaunchError> => {
    const before = fake.received.filter((m) => m.json?.type === "LAUNCH").length;
    const p = client.launch("APP1");
    const caught = p.then(() => undefined, (e: unknown) => e);
    const request = await fake.waitFor((m) => m.json?.type === "LAUNCH" && fake.received.filter((x) => x.json?.type === "LAUNCH").indexOf(m) === before);
    fake.sendJson(NS_RECEIVER, "receiver-0", client.senderId, { type: "LAUNCH_ERROR", requestId: request.json?.requestId, ...reply });
    const err = await caught;
    assert.ok(err instanceof CastLaunchError, String(err));
    return err;
  };
  const declined = await fail({ extendedError: "USER_NOT_ALLOWED" });
  assert.deepEqual([declined.failure, declined.description], ["user_not_allowed", "Failed to launch session as the user declined the cast request."]);
  const blocked = await fail({ extendedError: "USER_NOTIFICATIONS_DISABLED" });
  assert.deepEqual([blocked.failure, blocked.description], ["notification_disabled", "Failed to launch session as the notifications are disabled on the receiver device."]);
  const other = await fail({ error: "boom" });
  assert.deepEqual([other.failure, other.description], ["error", "Failed to launch session. boom"]);
  const bare = await fail({});
  assert.equal(bare.description, "Failed to launch session. ");
});

test("a LAUNCH_STATUS that is neither pending nor allowed fails the launch", async () => {
  const { fake, client } = await setup();
  fake.autoReply = false;
  await client.connect();
  await fake.ready();
  const p = client.launch("APP1");
  const caught = p.then(() => undefined, (e: unknown) => e);
  const request = await fake.waitFor((m) => m.json?.type === "LAUNCH");
  fake.sendJson(NS_RECEIVER, "receiver-0", client.senderId, { type: "LAUNCH_STATUS", requestId: request.json?.requestId, status: "SOMETHING_ELSE" });
  const err = await caught;
  assert.ok(err instanceof CastLaunchError);
  assert.equal(err.failure, "error");
});

// cast_message_handler.h kRequestTimeout, kDefaultLaunchTimeout; cast_message_handler.cc kLaunchMaxTimeout
test("requests wait 5 s, a launch 60 s by default and never more than 2 minutes", async () => {
  mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  try {
    const { fake, client } = await setup({ heartbeatTimeoutMs: 10_000_000, heartbeatIntervalMs: 10_000_000 });
    fake.autoReply = false;
    await client.connect();
    await until(() => fake.received.some((m) => m.json?.type === "CONNECT"), "CONNECT");

    let settled = "";
    client.getAppAvailability(["APP1"]).catch((e: unknown) => { settled = e instanceof CastTimeoutError ? "request timeout" : String(e); });
    mock.timers.tick(4999);
    await settle();
    assert.equal(settled, "", "still waiting at 4999 ms");
    mock.timers.tick(1);
    await until(() => settled !== "", "the request timeout");
    assert.equal(settled, "request timeout");

    let launchSettled = "";
    client.launch("APP1").catch((e: unknown) => { launchSettled = e instanceof CastTimeoutError ? "launch timeout" : String(e); });
    mock.timers.tick(59_999);
    await settle();
    assert.equal(launchSettled, "");
    mock.timers.tick(1);
    await until(() => launchSettled !== "", "the default launch timeout");

    let capped = "";
    client.launch("APP2", { timeoutMs: 600_000 }).catch(() => { capped = "capped"; });
    mock.timers.tick(119_999);
    await settle();
    assert.equal(capped, "");
    mock.timers.tick(1);
    await until(() => capped !== "", "the capped launch timeout");
  } finally {
    mock.timers.reset();
  }
});

// keep_alive_handler.cc: ResetTimers on every message, SendKeepAliveMessageComplete resets liveness only
test("a received message restarts the ping timer, which fires once; a completed ping restarts the liveness timer", async () => {
  mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  try {
    const { fake, client } = await setup({ heartbeatIntervalMs: 30, heartbeatTimeoutMs: 100 });
    fake.autoPong = false;
    await client.connect();
    await until(() => fake.received.some((m) => m.json?.type === "CONNECT"), "CONNECT");
    const pings = () => fake.received.filter((m) => m.namespace === NS_HEARTBEAT && m.json?.type === "PING");
    let ticks = 0;
    client.on("message", () => ticks++);

    mock.timers.tick(20);
    fake.sendJson("urn:x-cast:com.example.test", "transport-1", client.senderId, { type: "tick" });
    await until(() => ticks === 1, "a message");
    mock.timers.tick(20);
    await settle();
    assert.equal(pings().length, 0, "the message pushed the ping out: 40 ms since start, 20 since the message");
    mock.timers.tick(10);
    await until(() => pings().length === 1, "the ping, 30 ms after the message");
    await settle();

    // One-shot: with nothing received, no second ping comes
    mock.timers.tick(60);
    await settle();
    assert.equal(pings().length, 1);
    // The ping went out at t=50 ms and its completion restarted liveness, which is then due at t=150 ms (now 110)
    assert.equal(client.connected, true);
    const closed = once(client, "close");
    mock.timers.tick(40);
    const [err] = (await closed) as [Error | undefined];
    assert.ok(err instanceof CastConnectionError);
    assert.match(err.message, /heartbeat/);
  } finally {
    mock.timers.reset();
  }
});

test("a PING from the receiver is answered from sender-0 to receiver-0", async () => {
  const { fake, client } = await setup();
  await client.connect();
  await fake.ready();
  fake.sendJson(NS_HEARTBEAT, "receiver-0", client.senderId, { type: "PING" });
  const pong = await fake.waitFor((m) => m.namespace === NS_HEARTBEAT && m.json?.type === "PONG");
  assert.deepEqual([pong.sourceId, pong.destinationId], ["sender-0", "receiver-0"]);
});
