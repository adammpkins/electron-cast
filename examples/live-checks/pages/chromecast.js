// A page on electron-cast's own chrome.cast (preload mode "chromecast"). Nothing casts until the harness calls liveRequest().
const L = (kind, detail) => console.log(`LIVE ${kind} ${detail === undefined ? "" : detail}`);
const w = window;
const APP = new URLSearchParams(location.search).get("app") || "00000000";
w.__live = { ready: false, error: null, result: null, session: null };
try {
  const cfg = new chrome.cast.ApiConfig(
    new chrome.cast.SessionRequest(APP),
    (s) => { w.__live.session = s.sessionId; L("session", s.sessionId); },
    (a) => L("receiver", a),
    chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED,
  );
  chrome.cast.initialize(cfg, () => { w.__live.ready = true; L("initialized", `app=${APP}`); }, (e) => { w.__live.error = JSON.stringify(e); L("init.error", w.__live.error); });
} catch (e) { w.__live.error = String(e); L("error", w.__live.error); }
w.liveRequest = () => {
  chrome.cast.requestSession(
    (s) => { w.__live.result = `session ${s.sessionId}`; w.__live.session = s.sessionId; L("requestSession", w.__live.result); },
    (e) => { w.__live.result = `error ${e && e.code}: ${e && e.description}`; L("requestSession", w.__live.result); },
  );
  return "started";
};
