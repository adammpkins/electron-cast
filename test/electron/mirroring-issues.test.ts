// The issues a mirroring launch raises through MirroringManager, as Chrome's CastActivityManager and MediaRouterUI do:
// the receiver waiting for its user (SendPendingUserAuthNotification, cleared by USER_ALLOWED), a failed launch
// (HandleLaunchSessionResponseFailures) and, for a route the dialog asked for, the dialog's own issue
// (MediaRouterUI::OnRouteResponseReceived). A page's own mirroring request has no dialog, so only the provider's issues.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { CastLaunchError, CastTimeoutError } from "../../src/client/index.ts";
import type { MirroringClient } from "../../src/mirroring/mirroring-activity.ts";
import { MirroringManager } from "../../src/mirroring/mirroring-manager.ts";
import { IssueManager, RouterIssues } from "../../src/electron/issues.ts";
import { siteMirroringSource } from "../../src/electron/mirroring-to-flinging.ts";
import type { CastDevice } from "../../src/discovery/index.ts";

const TV: CastDevice = { id: "dev-1", name: "Living Room TV", model: "Fake", host: "127.0.0.1", addresses: ["127.0.0.1"], port: 8009, capabilities: 5, isGroup: false, statusText: "", instanceName: "dev-1", txt: {} };

class FakeClient extends EventEmitter implements MirroringClient {
  readonly senderId = "sender-fake01";
  statuses: ("pending_authorization" | "allowed")[] = [];
  error: Error | undefined;
  async connect(): Promise<void> {}
  close(): void {}
  send(): void {}
  async launch(appId: string, options?: { onStatus?: (status: "pending_authorization" | "allowed") => void }) {
    for (const status of this.statuses) options?.onStatus?.(status);
    if (this.error !== undefined) throw this.error;
    return { appId, displayName: "Fake Streaming", sessionId: "s1", transportId: "transport-s1", namespaces: [] };
  }
  async stop() {
    return { applications: [], volume: {} };
  }
  connectTransport(): void {}
  closeTransport(): void {}
}

function setup(client: FakeClient) {
  const issueManager = new IssueManager();
  const titles: string[] = [];
  issueManager.registerObserver({ onIssue: (i) => titles.push(i.info.title), onIssuesCleared: () => {} });
  const manager = new MirroringManager({
    findDevice: () => TV,
    createClient: () => client,
    createService: () => ({ onMessage() {}, stop() {} }),
    issues: new RouterIssues(issueManager, { mac: false }),
  });
  return { manager, issueManager, titles, now: () => issueManager.issuesNow().map((i) => i.info.title) };
}

const declined = (): CastLaunchError => new CastLaunchError({ type: "LAUNCH_ERROR", extendedError: "USER_NOT_ALLOWED" }, "user_not_allowed", "Failed to launch session as the user declined the cast request.");
const disabled = (): CastLaunchError => new CastLaunchError({ type: "LAUNCH_ERROR", extendedError: "USER_NOTIFICATIONS_DISABLED" }, "notification_disabled", "Failed to launch session as the notifications are disabled on the receiver device.");

async function finish(t: ReturnType<typeof setup>): Promise<void> {
  await t.manager.dispose();
  t.issueManager.dispose();
}

test("a launch the receiver holds for its user raises one pending-authorization notice, and USER_ALLOWED takes it away", async () => {
  const client = new FakeClient();
  client.statuses = ["pending_authorization", "allowed"];
  const t = setup(client);
  try {
    await t.manager.startMirroring(TV.id, { castMode: "tab_mirror", webContentsId: 5 });
    assert.deepEqual(t.titles, ["Accept cast request on your Living Room TV"], "raised once, not once per wiring");
    assert.deepEqual(t.now(), []);
  } finally {
    await finish(t);
  }
});

test("a launch still waiting for its user leaves the notice up", async () => {
  const client = new FakeClient();
  client.statuses = ["pending_authorization"];
  const t = setup(client);
  try {
    await t.manager.startMirroring(TV.id, { castMode: "tab_mirror", webContentsId: 5 });
    assert.deepEqual(t.now(), ["Accept cast request on your Living Room TV"]);
  } finally {
    await finish(t);
  }
});

test("a declined launch raises the dialog's declined warning and no Failed to cast; the pending notice is cleared", async () => {
  const client = new FakeClient();
  client.statuses = ["pending_authorization"];
  client.error = declined();
  const t = setup(client);
  try {
    await assert.rejects(t.manager.startMirroring(TV.id, { castMode: "tab_mirror", webContentsId: 5 }));
    assert.deepEqual(t.now(), ["Make sure to accept the cast request on your Living Room TV"]);
  } finally {
    await finish(t);
  }
});

test("a receiver with notifications off raises the dialog's notifications warning", async () => {
  const client = new FakeClient();
  client.error = disabled();
  const t = setup(client);
  try {
    await assert.rejects(t.manager.startMirroring(TV.id, { castMode: "tab_mirror", webContentsId: 5 }));
    assert.deepEqual(t.now(), ["Make sure notifications are turned on on your Living Room TV"]);
  } finally {
    await finish(t);
  }
});

test("any other failed launch raises Failed to cast; a timeout adds the dialog's tab timeout notice", async () => {
  const failing = new FakeClient();
  failing.error = new Error("boom");
  const a = setup(failing);
  try {
    await assert.rejects(a.manager.startMirroring(TV.id, { castMode: "tab_mirror", webContentsId: 5 }));
    assert.deepEqual(a.now(), ["Failed to cast. Please try again."]);
  } finally {
    await finish(a);
  }

  const slow = new FakeClient();
  slow.error = new CastTimeoutError("launch timed out");
  const b = setup(slow);
  try {
    await assert.rejects(b.manager.startMirroring(TV.id, { castMode: "tab_mirror", webContentsId: 5 }));
    assert.deepEqual(b.now(), ["Failed to cast. Please try again.", "Unable to cast tab"]);
  } finally {
    await finish(b);
  }
});

test("a page's own mirroring request raises the provider's issue only: no dialog, so no route-timeout or declined notice", async () => {
  const source = siteMirroringSource("cast:0F5096E8", 5)!;
  const slow = new FakeClient();
  slow.error = new CastTimeoutError("launch timed out");
  const t = setup(slow);
  try {
    await assert.rejects(t.manager.startSiteInitiatedMirroring(TV.id, source));
    assert.deepEqual(t.now(), ["Failed to cast. Please try again."]);
  } finally {
    await finish(t);
  }

  const refused = new FakeClient();
  refused.error = declined();
  const d = setup(refused);
  try {
    await assert.rejects(d.manager.startSiteInitiatedMirroring(TV.id, source));
    assert.deepEqual(d.now(), [], "the dialog's declined warning is not the provider's");
  } finally {
    await finish(d);
  }
});

test("the dialog's earlier issues go when a route is requested from it, not when a page requests one", async () => {
  const t = setup(new FakeClient());
  try {
    t.issueManager.addIssue({ title: "old", severity: "warning", sinkId: "dev-1" });
    await t.manager.startSiteInitiatedMirroring(TV.id, siteMirroringSource("cast:0F5096E8", 5)!);
    assert.deepEqual(t.now(), ["old"]);
    await t.manager.startMirroring(TV.id, { castMode: "tab_mirror", webContentsId: 6 });
    assert.deepEqual(t.now(), []);
  } finally {
    await finish(t);
  }
});
