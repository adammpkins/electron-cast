// The default presentation request of each window, kept like Chrome's WebContentsPresentationManager (see
// docs/MAIN-API.md): the page sets `navigator.presentation.defaultRequest`, the app's own cast UI reads it as the
// source of its PRESENTATION cast mode.

/** Chrome: `content::PresentationRequest`, for the one frame that can own a default request (the window's main frame). */
export interface PresentationRequest {
  /** The window's `webContents.id`; Chrome names the frame (`render_frame_host_id`), and only the outermost one counts. */
  webContentsId: number;
  /** `presentation_urls`: the URLs of the page's `PresentationRequest`, in order. */
  presentationUrls: string[];
  /** `frame_origin`: the origin of the frame that set it. */
  frameOrigin: string;
}

/** Chrome: `content::PresentationObserver`. */
export interface PresentationObserver {
  /** `OnDefaultPresentationChanged`: the new default request, or `null` when it was cleared. */
  onDefaultPresentationChanged(request: PresentationRequest | null): void;
}

export function samePresentationRequest(a: PresentationRequest, b: PresentationRequest): boolean {
  // ControllerPresentationServiceDelegateImpl's ArePresentationRequestsEqual: frame, URLs and origin
  return a.webContentsId === b.webContentsId && a.frameOrigin === b.frameOrigin
    && a.presentationUrls.length === b.presentationUrls.length
    && a.presentationUrls.every((u, i) => u === b.presentationUrls[i]);
}

/** Default requests per window, with their observers. */
export class DefaultPresentationRequests {
  private readonly requests = new Map<number, PresentationRequest>();
  private readonly serials = new Map<number, number>();
  private serial = 0;
  private readonly observers = new Map<number, Set<PresentationObserver>>();

  has(webContentsId: number): boolean {
    return this.requests.has(webContentsId);
  }

  get(webContentsId: number): PresentationRequest | null {
    const r = this.requests.get(webContentsId);
    return r === undefined ? null : { ...r, presentationUrls: [...r.presentationUrls] };
  }

  /** Changes with every set that is not a no-op, so a request cleared and set again (a new page) is not the same one. */
  serialOf(webContentsId: number): number | undefined {
    return this.serials.get(webContentsId);
  }

  /**
   * `PresentationServiceImpl::SetDefaultPresentationUrls` and the delegate's: the same URLs again change nothing; no
   * URLs clears the request; otherwise it is replaced. Observers hear of each real change.
   */
  set(webContentsId: number, urls: readonly string[], frameOrigin: string): void {
    const current = this.requests.get(webContentsId);
    if (urls.length === 0) {
      this.clear(webContentsId);
      return;
    }
    if (current !== undefined && current.presentationUrls.length === urls.length
      && current.presentationUrls.every((u, i) => u === urls[i])) return;
    const next: PresentationRequest = { webContentsId, presentationUrls: [...urls], frameOrigin };
    this.requests.set(webContentsId, next);
    this.serials.set(webContentsId, ++this.serial);
    this.notify(webContentsId, next);
  }

  /** `ClearDefaultPresentationRequest`: also what `Reset` does when the frame navigates or goes away. */
  clear(webContentsId: number): void {
    this.serials.delete(webContentsId);
    if (this.requests.delete(webContentsId)) this.notify(webContentsId, null);
  }

  /** The window is gone: clear its request (observers hear the final null), then forget its observers. */
  forget(webContentsId: number): void {
    this.clear(webContentsId);
    this.observers.delete(webContentsId);
  }

  observe(webContentsId: number, observer: PresentationObserver): () => void {
    let set = this.observers.get(webContentsId);
    if (set === undefined) this.observers.set(webContentsId, (set = new Set()));
    set.add(observer);
    return () => {
      set.delete(observer);
      if (set.size === 0 && this.observers.get(webContentsId) === set) this.observers.delete(webContentsId);
    };
  }

  dispose(): void {
    this.requests.clear();
    this.serials.clear();
    this.observers.clear();
  }

  private notify(webContentsId: number, request: PresentationRequest | null): void {
    for (const o of [...(this.observers.get(webContentsId) ?? [])]) {
      try {
        o.onDefaultPresentationChanged(request === null ? null : { ...request, presentationUrls: [...request.presentationUrls] });
      } catch (err) {
        console.error("electron-cast: a presentation observer failed", err);
      }
    }
  }
}
