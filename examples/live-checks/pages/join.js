// A page with Google's sender SDK (the plain chrome.cast API, no framework) for app CC1AD845. It starts no session: it only listens
// (the receiver listener, the session listener a session found by auto-join would reach) and, when the harness calls liveJoin(id)
// with a user gesture, joins a session another sender started: chrome.cast.requestSessionById.
const SDK = "https://www.gstatic.com/cv/js/sender/v1/cast_sender.js";
const APP_ID = "CC1AD845";
const L = (kind, detail) => console.log(`LIVE ${kind} ${detail === undefined ? "" : detail}`);
const w = window;
w.__live = { ready: false, error: null, sessions: [], receivers: [], media: [], updates: [], conns: [], events: [] };
const mark = (kind, detail) => { w.__live.events.push({ at: Date.now(), kind, detail }); L(kind, typeof detail === "string" ? detail : JSON.stringify(detail)); };

if (typeof PresentationRequest === "function") {
  try {
    const Orig = PresentationRequest;
    const track = (c, how, urls) => {
      const rec = { how, urls, id: String(c.id).slice(0, 40), events: [] };
      w.__live.conns.push(rec);
      for (const t of ["connect", "close", "terminate"]) c.addEventListener(t, (e) => { const ev = { type: t, state: c.state, reason: e.reason }; rec.events.push(ev); mark("connection." + t, { how, ...ev }); });
      return c;
    };
    for (const how of ["start", "reconnect"]) {
      const f = Orig.prototype[how];
      Orig.prototype[how] = function (...a) {
        mark("PresentationRequest." + how, a);
        return f.apply(this, a).then((c) => { mark("PresentationRequest." + how + " resolved", `state=${c.state}`); return track(c, how, a); }, (e) => { mark("PresentationRequest." + how + " rejected", `${e && e.name}: ${e && e.message}`); throw e; });
      };
    }
  } catch (e) { L("tracker.error", String(e)); }
}

const summarize = (s) => ({ sessionId: s.sessionId, status: s.status, appId: s.appId, device: s.receiver && s.receiver.friendlyName, statusText: s.statusText, media: (s.media || []).map((m) => m.playerState) });
const watchMedia = (m) => {
  w.__live.media.push({ at: Date.now(), state: m.playerState });
  mark("media", m.playerState);
  m.addUpdateListener(() => { w.__live.media.push({ at: Date.now(), state: m.playerState }); mark("media", m.playerState); });
};
const watch = (s, how) => {
  w.__live.sessions.push({ how, ...summarize(s) });
  mark("session", { how, ...summarize(s) });
  s.addUpdateListener((alive) => { w.__live.updates.push({ at: Date.now(), alive, status: s.status }); mark("session.update", { alive, status: s.status }); });
  s.addMediaListener(watchMedia);
  (s.media || []).forEach(watchMedia);
  w.__live.session = s;
};
w.__onGCastApiAvailable = (ok) => {
  if (!ok) { w.__live.error = "sdk unavailable"; return; }
  try {
    const request = new chrome.cast.SessionRequest(APP_ID);
    const config = new chrome.cast.ApiConfig(request, (s) => watch(s, "sessionListener"), (a) => { w.__live.receivers.push(a); mark("receiver", a); }, chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED);
    chrome.cast.initialize(config, () => { w.__live.ready = true; mark("sdk.ready"); }, (e) => { w.__live.error = `initialize ${JSON.stringify(e)}`; mark("sdk.error", w.__live.error); });
  } catch (e) { w.__live.error = String((e && e.stack) || e); mark("sdk.error", w.__live.error); }
};
// The harness calls this through executeJavaScript(code, true): the gesture the Presentation API demands
w.liveJoin = (id) => { mark("requestSessionById", id); chrome.cast.requestSessionById(id); return "started"; };
const s = document.createElement("script");
s.src = SDK;
s.onerror = () => { w.__live.error = "sdk load error"; };
document.head.append(s);
