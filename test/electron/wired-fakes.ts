import { EventEmitter } from "node:events";
import type { DisplayLike } from "../../src/electron/wired-display/displays.ts";
import type { ReceiverEnd } from "../../src/electron/wired-display/local-presentation.ts";
import type { ReceiverWindow, ReceiverWindowRequest, ScreenLike } from "../../src/electron/wired-display/provider.ts";

export const disp = (id: number, x: number, y: number, w = 1920, h = 1080): DisplayLike => ({ id, bounds: { x, y, width: w, height: h } });

export class FakeScreen extends EventEmitter implements ScreenLike {
  displays: DisplayLike[];
  primary: DisplayLike;
  constructor(displays: DisplayLike[] = [disp(1, 0, 0), disp(2, 1920, 0)]) {
    super();
    this.displays = displays;
    this.primary = displays[0]!;
  }
  getAllDisplays(): DisplayLike[] {
    return this.displays.map((d) => ({ id: d.id, bounds: { ...d.bounds } }));
  }
  getPrimaryDisplay(): DisplayLike {
    return this.primary;
  }
  add(d: DisplayLike): void {
    this.displays.push(d);
    this.emit("display-added", {}, d);
  }
  remove(id: number): void {
    const d = this.displays.find((x) => x.id === id)!;
    this.displays = this.displays.filter((x) => x.id !== id);
    this.emit("display-removed", {}, d);
  }
  move(id: number, x: number, y: number): void {
    const d = this.displays.find((v) => v.id === id)!;
    d.bounds = { ...d.bounds, x, y };
    this.emit("display-metrics-changed", {}, d, ["bounds"]);
  }
}

/** A receiver window whose page the test plays: `register()` is the page using `navigator.presentation`. */
export class FakeWindow implements ReceiverWindow {
  readonly request: ReceiverWindowRequest;
  started: { id: string; url: string } | null = null;
  fullscreen = true;
  closed = false;
  /** Receiver connections handed to the page, in order. */
  ends: ReceiverEnd[] = [];
  constructor(request: ReceiverWindowRequest) {
    this.request = request;
  }
  start(id: string, url: string): void {
    this.started = { id, url };
  }
  terminate(): void {
    this.close();
  }
  exitFullscreen(): void {
    this.fullscreen = false;
  }
  /** The window goes away (the user closed it, or terminate()). */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.started !== null) this.request.receiverReset(this.started.id);
    this.request.onTerminated();
  }
  /** The page touches navigator.presentation. */
  register(url = this.started!.url): void {
    this.request.receiverCreated({ id: this.started!.id, url }, (end) => this.ends.push(end));
  }
}

export function windowFactory() {
  const windows: FakeWindow[] = [];
  return {
    windows,
    create: (request: ReceiverWindowRequest): ReceiverWindow => {
      const w = new FakeWindow(request);
      windows.push(w);
      return w;
    },
  };
}
