/**
 * The parts of Chrome's offscreen tab that need no Electron, ported from Chromium:
 *  - `chrome/browser/media/offscreen_tab.cc` (`OffscreenTab::DieIfContentCaptureEnded`, `kMaxWaitForCapture`,
 *    `kPollInterval`),
 *  The size `CastMirroringServiceHost::OpenOffscreenTab` starts the tab with is `getCaptureResolutionConstraint` in
 *  `mirror-settings.ts`, the same cap a tab or desktop capture gets.
 *
 * An offscreen tab is how Chrome's Cast provider serves an ordinary https presentation URL ("1-UA mode"): the URL is
 * loaded in a tab that is in no window, and that tab is mirrored. See docs/DESIGN.md ("Presentation URLs on a Cast
 * device").
 */

/** `kMaxWaitForCapture`: how long an offscreen tab waits for its capture to start before it gives up. */
export const MAX_WAIT_FOR_CAPTURE_MS = 60_000;
/** `kPollInterval`. */
export const CAPTURE_POLL_INTERVAL_MS = 1000;

export interface CaptureWatchOptions {
  /** `WebContents::IsBeingCaptured()`. */
  isBeingCaptured(): boolean;
  /** `destroy_callback_`: runs at most once; the owner destroys the tab. */
  destroy(reason: "capture_ended" | "capture_never_started"): void;
  /** Timers and clock, for tests; default `setTimeout` (unref'd) and `Date.now`. */
  setTimeout?(cb: () => void, ms: number): () => void;
  now?(): number;
}

/**
 * `OffscreenTab::DieIfContentCaptureEnded`, started as `OffscreenTab::Start` starts it: every second, the tab is destroyed
 * when its capture was seen and is gone ("there are no more consumers of its captured content"), or when no capture was
 * seen within a minute of the start ("assume that content capture is never going to start and die to free up
 * resources"). Returns the function that stops the polling (the tab was destroyed some other way).
 */
export function watchCapture(options: CaptureWatchOptions): () => void {
  const now = options.now ?? (() => Date.now());
  const setTimer =
    options.setTimeout ??
    ((cb: () => void, ms: number) => {
      const t = setTimeout(cb, ms);
      t.unref();
      return () => clearTimeout(t);
    });
  const startTime = now();
  let captureWasDetected = false;
  let stopped = false;
  let cancel: (() => void) | undefined;
  const check = (): void => {
    if (stopped) return;
    let captured: boolean;
    try {
      captured = options.isBeingCaptured();
    } catch {
      // the contents are gone, and whoever destroyed them stops this
      return;
    }
    if (captureWasDetected) {
      if (!captured) {
        stopped = true;
        options.destroy("capture_ended");
        return;
      }
    } else if (captured) {
      captureWasDetected = true;
    } else if (now() - startTime > MAX_WAIT_FOR_CAPTURE_MS) {
      stopped = true;
      options.destroy("capture_never_started");
      return;
    }
    cancel = setTimer(check, CAPTURE_POLL_INTERVAL_MS);
  };
  check();
  return () => {
    stopped = true;
    cancel?.();
  };
}

/** What `CastMirroringServiceHost::OpenOffscreenTab` is asked for. */
export interface OffscreenTabRequest {
  /** `presentation_url`: the page the tab loads. */
  url: string;
  /** `presentation_id`: the id the tab's `navigator.presentation.receiver` registers under. */
  presentationId: string;
  /**
   * The tab is gone, for whatever reason (its page closed itself or navigated, its capture ended or never started, or
   * the owner destroyed it). Runs once.
   */
  onDestroyed(): void;
}

/** An open offscreen tab (`OffscreenTab`). */
export interface OffscreenTabHandle {
  /** `web_contents()`: the `webContents.id` of the tab, which is what the mirroring session captures. */
  readonly webContentsId: number;
  /** `CastMirroringServiceHost::DestroyOffscreenTab` (`offscreen_tab_.reset()`): the contents are deleted at once. */
  destroy(): void;
}

/** `CastMirroringServiceHostFactory::GetForOffscreenTab`, as far as the tab goes. Throws when the tab cannot be made. */
export type OffscreenTabOpener = (request: OffscreenTabRequest) => OffscreenTabHandle;
