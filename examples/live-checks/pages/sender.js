// Runs in whichever frame carries Google's Cast SDK. Nothing casts until the harness calls window.liveCast() with a user gesture.
const SDK = "https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1";
const APP_ID = "CC1AD845"; // Default Media Receiver
const VIDEO = "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4"; // the gtv-videos-bucket samples answer 403 now
const L = (kind, detail) => console.log(`LIVE ${kind} ${detail === undefined ? "" : detail}`);
const w = window;
w.__live = { ready: false, error: null, states: [], players: [], session: null, defaultRequest: null, standIn: null };
const native = (f) => /\[native code\]/.test(Function.prototype.toString.call(f));
w.__live.standIn = typeof PresentationRequest === "function" && !native(PresentationRequest);
L("frame", `${location.origin} standIn=${w.__live.standIn}`);

w.__onGCastApiAvailable = (ok) => {
  if (!ok) { w.__live.error = "sdk unavailable"; L("sdk.unavailable"); return; }
  try {
    const ctx = cast.framework.CastContext.getInstance();
    ctx.setOptions({ receiverApplicationId: APP_ID, autoJoinPolicy: chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED });
    const player = new cast.framework.RemotePlayer();
    const controller = new cast.framework.RemotePlayerController(player);
    w.__live.ctx = ctx;
    ctx.addEventListener(cast.framework.CastContextEventType.CAST_STATE_CHANGED, (e) => { w.__live.states.push(e.castState); L("castState", e.castState); });
    ctx.addEventListener(cast.framework.CastContextEventType.SESSION_STATE_CHANGED, (e) => {
      const s = ctx.getCurrentSession();
      w.__live.session = { state: e.sessionState, id: s ? s.getSessionId() : null, device: s ? s.getCastDevice().friendlyName : null };
      L("sessionState", JSON.stringify(w.__live.session));
      if (e.sessionState === cast.framework.SessionState.SESSION_STARTED && w.__live.autoload) w.__live.load();
    });
    controller.addEventListener(cast.framework.RemotePlayerEventType.ANY_CHANGE, (e) => {
      if (["isConnected", "isMediaLoaded", "playerState"].includes(e.field)) { w.__live.players.push(`${e.field}=${e.value}`); L("player", `${e.field}=${e.value}`); }
    });
    w.__live.load = async () => {
      const s = ctx.getCurrentSession(); if (!s) return "no session";
      const info = new chrome.cast.media.MediaInfo(VIDEO, "video/mp4");
      info.streamType = chrome.cast.media.StreamType.BUFFERED;
      const err = await s.loadMedia(new chrome.cast.media.LoadRequest(info));
      L("loadMedia", err ? `error ${err}` : "ok");
      return err ? `error ${err}` : "ok";
    };
    w.__live.playerState = () => (player.isConnected ? `${player.playerState}` : "not connected");
    w.__live.mediaSessionState = () => { const s = ctx.getCurrentSession(); const m = s && s.getMediaSession(); return m ? m.playerState : null; };
    // In Chrome the SDK sets navigator.presentation.defaultRequest itself; record what it did
    w.__live.defaultRequest = navigator.presentation && navigator.presentation.defaultRequest ? "set" : "null";
    w.__live.ready = true;
    L("sdk.ready", `castState=${ctx.getCastState()} defaultRequest=${w.__live.defaultRequest}`);
  } catch (e) { w.__live.error = String((e && e.stack) || e); L("sdk.error", w.__live.error); }
};
// The harness calls this through executeJavaScript(code, true): the gesture the Presentation API demands
w.liveCast = (autoload) => {
  w.__live.autoload = autoload !== false;
  L("liveCast", `userActivation=${navigator.userActivation && navigator.userActivation.isActive}`);
  w.__live.request = w.__live.ctx.requestSession().then((err) => { w.__live.requestResult = err ? `error ${err}` : "ok"; L("requestSession", w.__live.requestResult); }, (e) => { w.__live.requestResult = `threw ${e}`; L("requestSession", w.__live.requestResult); });
  return "started";
};
w.liveStop = () => { w.__live.ctx.endCurrentSession(true); return "stopping"; };
// Presentation API constructor probe, for the sandbox variants
w.liveProbeConstructor = () => { try { new PresentationRequest(["cast:" + APP_ID]); return "constructed"; } catch (e) { return `threw ${e && e.name}: ${e && e.message}`; } };
if (new URLSearchParams(location.search).get("sdk") !== "0") {
  const s = document.createElement("script"); s.src = SDK; s.onerror = () => { w.__live.error = "sdk load error"; L("sdk.load-error"); }; document.head.append(s);
}
