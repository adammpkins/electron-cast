import vm from "node:vm";
import { installChromeCast } from "../../src/polyfill/install.ts";
import type { BridgeEvent, BridgeResult, CastBridge, SessionSnapshot } from "../../src/polyfill/bridge-types.ts";

export const BRIDGE_KEY = "__electronCastBridge";

export interface Harness {
  /** The vm global: the page's `window`. */
  win: any;
  calls: { method: string; params: any }[];
  /** Per-method reply; default `{ ok: true, value: undefined }`. */
  handlers: Record<string, (params: any) => BridgeResult | Promise<BridgeResult>>;
  emit(event: BridgeEvent): void;
  /** Run code in the page realm. */
  run(code: string): any;
  errors: unknown[];
}

/**
 * Evaluates the polyfill from its source text in a fresh vm context that has only the bridge and timers, which
 * proves the install function is self-contained (as contextBridge.executeInMainWorld requires).
 */
export function createHarness(opts: { install?: boolean | ((bridgeKey: string) => boolean); before?: string; withBridge?: boolean } = {}): Harness {
  const calls: Harness["calls"] = [];
  const handlers: Harness["handlers"] = {};
  const errors: unknown[] = [];
  let listener: ((e: BridgeEvent) => void) | null = null;
  const bridge: CastBridge = {
    call: async (method, params) => {
      calls.push({ method, params: JSON.parse(JSON.stringify(params ?? null)) });
      const h = handlers[method];
      return h ? h(params) : { ok: true, value: undefined };
    },
    onEvent: (l) => {
      listener = l;
    },
  };
  const sandbox: Record<string, unknown> = {
    setTimeout,
    clearTimeout,
    queueMicrotask,
    // The browser globals the Presentation installer relies on.
    EventTarget,
    Event,
    DOMException,
    URLSearchParams,
    navigator: Object.create({}),
    console: { ...console, error: (...a: unknown[]) => errors.push(a) },
  };
  if (opts.withBridge !== false) sandbox[BRIDGE_KEY] = bridge;
  const ctx = vm.createContext(sandbox);
  vm.runInContext("globalThis.window = globalThis;", ctx);
  if (opts.before) vm.runInContext(opts.before, ctx);
  const h: Harness = {
    win: ctx,
    calls,
    handlers,
    errors,
    emit: (e) => listener?.(e),
    run: (code) => vm.runInContext(code, ctx),
  };
  if (opts.install !== false) install(h, opts.install === true ? undefined : opts.install);
  return h;
}

export function install(h: Harness, installer: (bridgeKey: string) => boolean = installChromeCast): boolean {
  return h.run(`(${installer.toString()})(${JSON.stringify(BRIDGE_KEY)})`);
}

export const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** Copy a value out of the vm realm into plain main-realm JSON. */
export const plain = (v: unknown) => JSON.parse(JSON.stringify(v));

export function snapshot(over: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    sessionId: "session-1",
    appId: "233637DE",
    displayName: "YouTube",
    appImages: [{ url: "https://example.test/icon.png" }],
    statusText: "YouTube",
    namespaces: [{ name: "urn:x-cast:com.google.youtube.mdx" }, { name: "urn:x-cast:com.google.cast.media" }],
    transportId: "transport-1",
    receiver: {
      label: "afdd4ab851bc954c170d37581867bf54",
      friendlyName: "Lounge Cast TV",
      capabilities: ["video_out", "audio_out"],
      volume: { level: 0.5, muted: false, controlType: "attenuation", stepInterval: 0.05 },
      isActiveInput: null,
    },
    ...over,
  };
}
