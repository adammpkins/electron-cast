// Runs inside each iframe (and shows what that frame alone sees). Google's real Cast sender SDK is loaded, unmodified.
// Nothing here starts a cast by itself: only the Cast button does, and the SDK's own requestSession() needs a click.
const SDK = "https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1";
const APP_ID = "CC1AD845"; // the Default Media Receiver
const STREAM = "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8";

const params = new URLSearchParams(location.search);
const state = {
  frame: params.get("name") ?? "?",
  origin: location.origin,
  instance: Math.random().toString(36).slice(2, 8),
  nav: params.get("n") ?? "0",
  // the page-side stand-in is a script class; the browser's own PresentationRequest is native code
  presentationStandIn:
    typeof PresentationRequest === "function" && !/\[native code\]/.test(Function.prototype.toString.call(PresentationRequest)),
  sdkLoaded: false,
  castState: null,
  sessionState: null,
  sessionId: null,
  device: null,
  player: null,
  events: 0,
  error: null,
  reported: false,
};
const $ = (id) => document.getElementById(id);
$("title").textContent = `${state.frame === "same" ? "Same-origin" : "Cross-origin"} iframe (nav #${state.nav})`;

const time = () => new Date().toISOString().slice(11, 23);
function event(kind, detail) {
  state.events++;
  const line = `${time()} ${kind}${detail === undefined ? "" : " " + detail}`;
  $("events").textContent += line + "\n";
  $("events").scrollTop = $("events").scrollHeight;
  console.log(`LIVE_EVENT ${state.frame} ${line}`);
  publish();
}
function publish() {
  $("origin").textContent = state.origin;
  $("instance").textContent = state.instance;
  $("presentation").textContent = state.presentationStandIn ? "electron-cast stand-in installed" : "NOT installed (no cast in this frame)";
  $("castState").textContent = String(state.castState);
  $("sessionState").textContent = String(state.sessionState);
  $("sessionId").textContent = String(state.sessionId);
  $("device").textContent = String(state.device);
  $("player").textContent = String(state.player);
  $("count").textContent = String(state.events);
  console.log(`LIVE_STATE ${JSON.stringify(state)}`);
  parent.postMessage({ live: "state", state }, "*");
}

// Record what the stand-in delivers to this frame: connections created by the SDK's start()/reconnect(), and the
// envelope type of each message on them. Installed before the SDK loads, so the SDK only ever sees the wrapped class.
if (state.presentationStandIn) {
  const watch = (promise, how) =>
    promise.then((connection) => {
      event(`presentation.${how}`, `connection ${String(connection.id).slice(0, 8)} state=${connection.state}`);
      for (const type of ["connect", "close", "terminate"]) connection.addEventListener(type, () => event(`presentation.${type}`));
      connection.addEventListener("message", (e) => {
        let t = "?";
        try {
          const m = JSON.parse(e.data);
          t = m.type + (m.message && m.message.sessionId ? ` session=${String(m.message.sessionId).slice(0, 8)}` : "");
        } catch {
          // not JSON
        }
        event("presentation.message", t);
      });
      return connection;
    });
  for (const how of ["start", "reconnect"]) {
    const original = PresentationRequest.prototype[how];
    PresentationRequest.prototype[how] = function (...args) {
      return watch(original.apply(this, args), how);
    };
  }
}

function init() {
  const ctx = cast.framework.CastContext.getInstance();
  ctx.setOptions({
    receiverApplicationId: APP_ID,
    // Rejoins this frame's own parked session after the frame navigates (see the README)
    autoJoinPolicy: chrome.cast.AutoJoinPolicy.TAB_AND_ORIGIN_SCOPED,
  });
  state.sdkLoaded = true;
  state.castState = ctx.getCastState();
  event("sdk.loaded", `castState=${state.castState}`);
  ctx.addEventListener(cast.framework.CastContextEventType.CAST_STATE_CHANGED, (e) => {
    state.castState = e.castState;
    event("CAST_STATE_CHANGED", e.castState);
  });
  const player = new cast.framework.RemotePlayer();
  const controller = new cast.framework.RemotePlayerController(player);
  const show = () => {
    const s = ctx.getCurrentSession();
    state.sessionId = s ? s.getSessionId() : null;
    state.device = s ? s.getCastDevice().friendlyName : null;
    state.player = player.isConnected ? `${player.playerState ?? "no media"}` : "not connected";
    publish();
  };
  ctx.addEventListener(cast.framework.CastContextEventType.SESSION_STATE_CHANGED, (e) => {
    state.sessionState = e.sessionState;
    show();
    event("SESSION_STATE_CHANGED", `${e.sessionState} session=${state.sessionId === null ? "none" : state.sessionId.slice(0, 8)}`);
    // Load only for a session this click started; a resumed one keeps what it was playing
    if (e.sessionState === cast.framework.SessionState.SESSION_STARTED) load();
  });
  controller.addEventListener(cast.framework.RemotePlayerEventType.ANY_CHANGE, (e) => {
    if (["isConnected", "isMediaLoaded", "playerState", "mediaInfo"].includes(e.field)) {
      show();
      event("player." + e.field, e.field === "mediaInfo" ? (e.value ? "set" : "none") : String(e.value));
    }
  });

  const load = async () => {
    const session = ctx.getCurrentSession();
    if (!session) return event("load", "no session");
    const info = new chrome.cast.media.MediaInfo(STREAM, "application/x-mpegURL");
    info.streamType = chrome.cast.media.StreamType.BUFFERED;
    const error = await session.loadMedia(new chrome.cast.media.LoadRequest(info));
    event("loadMedia", error ? `error ${error}` : "ok");
  };
  // requestSession() is only ever called from a click, so it carries the user gesture the stand-in requires
  $("cast").onclick = async () => {
    event("click", "Cast");
    const error = await ctx.requestSession();
    event("requestSession", error ? `error ${error}` : "ok");
  };
  $("load").onclick = load;
  $("playpause").onclick = () => controller.playOrPause();
  $("leave").onclick = () => ctx.endCurrentSession(false);
  $("stop").onclick = () => ctx.endCurrentSession(true);
  // The SDK reports a state once it has probed for devices; give it a moment before the first "reported"
  setTimeout(() => {
    state.reported = true;
    state.castState = ctx.getCastState();
    show();
  }, 2500);
}

window.__onGCastApiAvailable = (available) => {
  if (!available) {
    state.error = "the SDK reported cast unavailable";
    state.reported = true;
    event("sdk.unavailable");
    return;
  }
  try {
    init();
  } catch (error) {
    state.error = String(error && error.stack || error);
    state.reported = true;
    event("sdk.init-error", state.error);
  }
};
const script = document.createElement("script");
script.src = SDK;
script.onerror = () => {
  state.error = "could not load the Cast SDK script";
  state.reported = true;
  event("sdk.load-error");
};
document.head.append(script);
// Without the stand-in the SDK may stay silent; report anyway so the page (and --selftest) shows what happened
setTimeout(() => {
  if (!state.reported && !state.presentationStandIn) {
    state.reported = true;
    publish();
  }
}, 8000);
publish();
