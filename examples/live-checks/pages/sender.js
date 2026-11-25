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

// Passive record of what the page does with the Presentation API: the URLs it asks for, each connection it gets, the
// messages it sends and every close or terminate event with its reason. It changes nothing the SDK sees.
w.__live.requests = [];
w.__live.conns = [];
if (typeof PresentationRequest === "function") {
  try {
    const Orig = PresentationRequest;
    const urlsOf = (r) => (r && r.__liveUrls) || [];
    const summarize = (m) => {
      if (typeof m !== "string") return `<${typeof m}>`;
      try { const j = JSON.parse(m); return j.type + (j.message && j.message.type ? `/${j.message.type}` : ""); } catch { return m.slice(0, 40); }
    };
    const track = (c, how, r) => {
      const rec = { how, urls: urlsOf(r), id: String(c.id).slice(0, 8), events: [], sent: [], received: [] };
      w.__live.conns.push(rec);
      for (const t of ["connect", "close", "terminate"]) {
        c.addEventListener(t, (e) => { const ev = { type: t, state: c.state, reason: e.reason, message: e.message }; rec.events.push(ev); L("connection." + t, JSON.stringify({ how, ...ev })); });
      }
      c.addEventListener("message", (e) => { const m = summarize(e.data); if (rec.received.length < 40) rec.received.push(m); });
      const send = c.send.bind(c);
      c.send = (m) => { const t = summarize(m); if (rec.sent.length < 40) rec.sent.push(t); return send(m); };
      return c;
    };
    window.PresentationRequest = new Proxy(Orig, {
      construct(target, args) {
        const r = Reflect.construct(target, args);
        r.__liveUrls = [].concat(args[0]);
        w.__live.requests.push(r.__liveUrls);
        L("PresentationRequest", JSON.stringify(r.__liveUrls));
        return r;
      },
    });
    for (const how of ["start", "reconnect"]) {
      const f = Orig.prototype[how];
      Orig.prototype[how] = function (...a) {
        L("PresentationRequest." + how, JSON.stringify([...urlsOf(this), ...a]));
        return f.apply(this, a).then((c) => { L("PresentationRequest." + how + " resolved", `state=${c.state}`); return track(c, how, this); }, (e) => { L("PresentationRequest." + how + " rejected", `${e && e.name}: ${e && e.message}`); throw e; });
      };
    }
  } catch (e) { L("tracker.error", String(e)); }
}

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

// Ending a session from the page, the two ways the SDK offers: Session.leave() (leave_session) and Session.stop().
w.liveLeave = () => { const o = w.__live.ctx.getCurrentSession().getSessionObj(); o.leave(() => L("leave", "ok"), (e) => L("leave", `error ${JSON.stringify(e)}`)); return "leaving"; };
w.liveStopSession = () => { const o = w.__live.ctx.getCurrentSession().getSessionObj(); o.stop(() => L("stop", "ok"), (e) => L("stop", `error ${JSON.stringify(e)}`)); return "stopping"; };
w.liveReceiver = () => { const s = w.__live.ctx.getCurrentSession(); const r = s && s.getSessionObj().receiver; return JSON.stringify(r ? { label: r.label, friendlyName: r.friendlyName } : null); };
// Site-initiated mirroring: a PresentationRequest for a Cast Streaming URL, started by the page (the harness gives the gesture).
w.liveAvailability = async (url) => { const a = await new PresentationRequest([url]).getAvailability(); return a.value; };
w.liveSiteStart = (url) => { w.__live.siteResult = "pending"; new PresentationRequest([url]).start().then((c) => { w.__live.siteConn = c; w.__live.siteResult = `connection ${c.state}`; }, (e) => { w.__live.siteResult = `rejected ${e && e.name}: ${e && e.message}`; }); return "started"; };
w.liveSiteTerminate = () => { w.__live.siteConn.terminate(); return "terminating"; };
// Presentation API constructor probe, for the sandbox variants
w.liveProbeConstructor = () => { try { new PresentationRequest(["cast:" + APP_ID]); return "constructed"; } catch (e) { return `threw ${e && e.name}: ${e && e.message}`; } };
// The SDK initializes (and auto-joins) when it loads, so a check that needs the page to have no SDK yet loads it later.
w.liveLoadSdk = () => { const s = document.createElement("script"); s.src = SDK; s.onerror = () => { w.__live.error = "sdk load error"; L("sdk.load-error"); }; document.head.append(s); return "loading"; };
if (new URLSearchParams(location.search).get("sdk") !== "0") w.liveLoadSdk();
