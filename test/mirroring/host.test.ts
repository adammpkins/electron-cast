import { test } from "node:test";
import assert from "node:assert/strict";
import { createElectronMirroringServiceFactory, type ElectronMirroringApi } from "../../src/mirroring/electron/host.ts";
import type { FromEngine } from "../../src/mirroring/electron/engine-process.ts";
import { sleep } from "./session-harness.ts";

/** The Electron host with stand-ins for BrowserWindow and utilityProcess: what happens when the engine goes wrong. */
function fakeElectron() {
  const state = {
    windows: [] as { destroyed: boolean }[],
    procs: [] as { handlers: { message: ((m: FromEngine) => void)[]; exit: ((code: number) => void)[] }; posted: unknown[]; killed: boolean }[],
  };
  const page = {
    id: 7,
    isDestroyed: () => false,
    getMediaSourceId: () => "id",
    executeJavaScript: async (code: string) => (code.includes("isConfigSupported") ? ["vp8"] : undefined),
    postMessage() {},
    setWindowOpenHandler() {},
    on() {},
    session: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, setDisplayMediaRequestHandler() {} },
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
    desktopCapturer: { getSources: async () => [] },
    webContents: { fromId: () => page },
  } as unknown as ElectronMirroringApi;
  return { electron, state };
}

async function start() {
  const { electron, state } = fakeElectron();
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
  return { state, errors, service, host };
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
