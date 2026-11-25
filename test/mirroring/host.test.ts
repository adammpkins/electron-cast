import { test } from "node:test";
import assert from "node:assert/strict";
import { createElectronMirroringServiceFactory, type ElectronMirroringApi } from "../../src/mirroring/electron/host.ts";
import type { FromEngine } from "../../src/mirroring/electron/engine-process.ts";
import { sleep } from "./session-harness.ts";

/** The Electron host with stand-ins for BrowserWindow and utilityProcess: what happens when the engine goes wrong. */
function fakeElectron() {
  const state = {
    windows: [] as { destroyed: boolean }[],
    request: undefined as ((wc: unknown, permission: string, cb: (granted: boolean) => void) => void) | undefined,
    display: undefined as ((request: unknown, cb: (streams: { video?: unknown; audio?: string }) => void) => void) | undefined,
    check: undefined as ((wc: unknown, permission: string) => boolean) | undefined,
    procs: [] as { handlers: { message: ((m: FromEngine) => void)[]; exit: ((code: number) => void)[] }; posted: unknown[]; killed: boolean }[],
  };
  const page = {
    id: 7,
    muted: false,
    muteCalls: [] as boolean[],
    isAudioMuted() { return this.muted; },
    setAudioMuted(m: boolean) { this.muted = m; this.muteCalls.push(m); },
    isDestroyed: () => false,
    getMediaSourceId: () => "id",
    executeJavaScript: async (code: string) => (code.includes("isConfigSupported") ? ["vp8"] : undefined),
    postMessage() {},
    setWindowOpenHandler() {},
    on() {},
    session: {
      setPermissionRequestHandler(h: typeof state.request) { state.request = h; },
      setPermissionCheckHandler(h: typeof state.check) { state.check = h; },
      setDisplayMediaRequestHandler(h: typeof state.display) { state.display = h; },
    },
  };
  const electron = {
    BrowserWindow: class {
      destroyedFlag = { destroyed: false };
      webContents = page;
      constructor() { state.windows.push(this.destroyedFlag); }
      async loadFile() {}
      destroy() { this.destroyedFlag.destroyed = true; }
      isDestroyed() { return this.destroyedFlag.destroyed; }
    },
    utilityProcess: {
      fork() {
        const proc = { handlers: { message: [] as ((m: FromEngine) => void)[], exit: [] as ((code: number) => void)[] }, posted: [] as unknown[], killed: false };
        state.procs.push(proc);
        return {
          postMessage: (m: unknown) => void proc.posted.push(m),
          on(event: "message" | "exit" | "spawn", l: never) { if (event !== "spawn") (proc.handlers[event] as unknown[]).push(l); },
          kill() { proc.killed = true; return true; },
          stdout: null,
          stderr: null,
        };
      },
    },
    MessageChannelMain: class { port1 = { postMessage() {}, start() {}, close() {} }; port2 = { postMessage() {}, start() {}, close() {} }; },
    desktopCapturer: { getSources: async () => [{ id: "screen:1:0", name: "Screen 1" }] },
    webContents: { fromId: () => page },
  } as unknown as ElectronMirroringApi;
  return { electron, state, page };
}

async function start(alreadyMuted = false) {
  const { electron, state, page } = fakeElectron();
  page.muted = alreadyMuted;
  const host = createElectronMirroringServiceFactory({ electron, engineModulePath: "engine.js" });
  const errors: string[] = [];
  const service = host.factory(
    { type: "av", receiverAddress: "127.0.0.1", sourceId: "s", destinationId: "d" } as never,
    { onError: (e, m) => void errors.push(`${e}: ${m}`) },
    { send() {} },
    { type: "tab", id: "urn:x-org.chromium.media:source:tab:7" } as never,
  );
  for (let i = 0; i < 100 && state.procs.length === 0; i++) await sleep(5);
  assert.equal(state.procs.length, 1, "the engine was started");
  return { state, errors, service, host, page };
}

test("host: an engine that exits unexpectedly reports the error and tears down the window and process", async () => {
  const { state, errors, host } = await start();
  state.procs[0]!.handlers.exit.forEach((h) => h(139));
  assert.deepEqual(errors, ["CAST_TRANSPORT_ERROR: the mirroring engine exited (139)"]);
  assert.equal(state.windows[0]!.destroyed, true);
  assert.deepEqual(state.procs[0]!.posted.at(-1), { type: "stop" });
  host.dispose();
});

test("host: an engine error message tears down the window and process even if the owner does nothing", async () => {
  const { state, errors, host } = await start();
  state.procs[0]!.handlers.message.forEach((h) => h({ type: "error", error: "AUDIO_CAPTURE_ERROR", message: "no audio" }));
  assert.deepEqual(errors, ["AUDIO_CAPTURE_ERROR: no audio"]);
  assert.equal(state.windows[0]!.destroyed, true);
  assert.deepEqual(state.procs[0]!.posted.at(-1), { type: "stop" });
  host.dispose();
});

test("host: stopping on purpose is not an error", async () => {
  const { state, errors, service, host } = await start();
  service.stop();
  state.procs[0]!.handlers.exit.forEach((h) => h(0));
  assert.deepEqual(errors, []);
  assert.equal(state.windows[0]!.destroyed, true);
  host.dispose();
});

test("host: the capture window's own session grants media and display capture, and nothing else", async () => {
  const { state, host } = await start();
  const asked = (permission: string): boolean => {
    let granted = false;
    state.request!(null, permission, (g) => { granted = g; });
    return granted && state.check!(null, permission);
  };
  // Desktop capture is refused as "Permission denied" (NotAllowedError) unless display-capture is granted.
  assert.equal(asked("media"), true);
  assert.equal(asked("display-capture"), true);
  assert.equal(asked("geolocation"), false);
  assert.equal(asked("notifications"), false);
  host.dispose();
});

test("host: a mirrored tab is silent locally for the session and unmuted after, but only if the host muted it", async () => {
  const a = await start();
  assert.equal(a.page.muted, true, "muted for the session (Chrome's Muter, crbug.com/40708932)");
  a.service.stop();
  assert.equal(a.page.muted, false);
  assert.deepEqual(a.page.muteCalls, [true, false]);
  a.host.dispose();

  const b = await start(true);
  b.service.stop();
  assert.equal(b.page.muted, true, "a tab that was already muted stays muted");
  assert.deepEqual(b.page.muteCalls, []);
  b.host.dispose();
});

test("host: desktop audio follows Chrome's GetDesktopAudioLoopbackDeviceId: keep local audio on Windows, mute elsewhere", async () => {
  for (const [option, expected] of [[undefined, process.platform === "win32" ? "loopback" : "loopbackWithMute"], ["loopback", "loopback"], ["loopbackWithMute", "loopbackWithMute"]] as const) {
    const { electron, state } = fakeElectron();
    const host = createElectronMirroringServiceFactory({ electron, engineModulePath: "engine.js", desktopAudio: option });
    host.factory(
      { type: "av", receiverAddress: "127.0.0.1", sourceId: "s", destinationId: "d" } as never,
      {},
      { send() {} },
      { type: "desktop", id: "urn:x-org.chromium.media:source:desktop:screen:1:0?with_audio=true" } as never,
    );
    for (let i = 0; i < 100 && state.procs.length === 0; i++) await sleep(5);
    let streams: { video?: unknown; audio?: string } | undefined;
    state.display!(null, (r) => { streams = r; });
    assert.equal(streams?.audio, expected);
    assert.deepEqual(streams?.video, { id: "screen:1:0", name: "Screen 1" });
    host.dispose();
  }
});
