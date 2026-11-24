import type { BridgeEvent, CastBridge } from "./bridge-types.ts";

export type {
  BridgeEvent,
  BridgeMethod,
  BridgeResult,
  CastBridge,
  ImageSnapshot,
  InitializeParams,
  InitializeResult,
  ReceiverSnapshot,
  RequestSessionParams,
  SessionSnapshot,
  VolumeSnapshot,
} from "./bridge-types.ts";

/**
 * Installs the legacy Google Cast sender API (`chrome.cast`, version [1, 2]) on the page's global object,
 * forwarding every operation to the electron-cast bridge that the preload script published at
 * `globalThis[bridgeKey]`. Returns `true` when the polyfill was installed, `false` when the bridge is
 * missing or `chrome.cast` already exists (in which case nothing is changed).
 *
 * Electron runs this function in the page's main world through `contextBridge.executeInMainWorld`, which
 * serializes it to source; the body must therefore stay self-contained: no imports, no module-level
 * helpers or state. Type annotations are stripped and leave no runtime references behind.
 */
export function installChromeCast(bridgeKey: string): boolean {
  const g: any = globalThis;
  const rawBridge: any = g[bridgeKey];
  if (!rawBridge || typeof rawBridge.call !== "function") return false;
  const bridge: CastBridge = rawBridge;
  if (g.chrome && g.chrome.cast) return false;
  g.chrome ??= {};

  const VERSION = [1, 2];
  const AutoJoinPolicy = { TAB_AND_ORIGIN_SCOPED: "tab_and_origin_scoped", ORIGIN_SCOPED: "origin_scoped", PAGE_SCOPED: "page_scoped" };
  const Capability = { VIDEO_OUT: "video_out", AUDIO_OUT: "audio_out", VIDEO_IN: "video_in", AUDIO_IN: "audio_in", MULTIZONE_GROUP: "multizone_group" };
  const DefaultActionPolicy = { CREATE_SESSION: "create_session", CAST_THIS_TAB: "cast_this_tab" };
  const DialAppState = { RUNNING: "running", STOPPED: "stopped", ERROR: "error" };
  const ErrorCode = {
    CANCEL: "cancel", TIMEOUT: "timeout", API_NOT_INITIALIZED: "api_not_initialized", INVALID_PARAMETER: "invalid_parameter",
    EXTENSION_NOT_COMPATIBLE: "extension_not_compatible", EXTENSION_MISSING: "extension_missing",
    RECEIVER_UNAVAILABLE: "receiver_unavailable", SESSION_ERROR: "session_error", CHANNEL_ERROR: "channel_error",
    LOAD_MEDIA_FAILED: "load_media_failed",
  };
  const ReceiverAction = { CAST: "cast", STOP: "stop" };
  const ReceiverAvailability = { AVAILABLE: "available", UNAVAILABLE: "unavailable" };
  const ReceiverType = { CAST: "cast", DIAL: "dial", HANGOUT: "hangout", CUSTOM: "custom" };
  const SenderPlatform = { CHROME: "chrome", IOS: "ios", ANDROID: "android" };
  const SessionStatus = { CONNECTED: "connected", DISCONNECTED: "disconnected", STOPPED: "stopped" };
  const VolumeControlType = { ATTENUATION: "attenuation", FIXED: "fixed", MASTER: "master" };
  const media = { DEFAULT_MEDIA_RECEIVER_APP_ID: "CC1AD845" };

  class Timeout {
    requestSession = 60000;
    leaveSession = 3000;
    stopSession = 3000;
    setReceiverVolume = 3000;
    sendCustomMessage = 3000;
  }

  class ApiConfig {
    sessionRequest: any;
    sessionListener: any;
    receiverListener: any;
    autoJoinPolicy: any;
    defaultActionPolicy: any;
    additionalSessionRequests: any[];
    customDialLaunchCallback: any;
    invisibleSender: boolean;
    constructor(sessionRequest: any, sessionListener: any, receiverListener: any, autoJoinPolicy: any = "tab_and_origin_scoped", defaultActionPolicy: any = "create_session") {
      this.sessionRequest = sessionRequest;
      this.sessionListener = sessionListener;
      this.receiverListener = receiverListener;
      this.autoJoinPolicy = autoJoinPolicy;
      this.defaultActionPolicy = defaultActionPolicy;
      this.additionalSessionRequests = [];
      this.customDialLaunchCallback = null;
      this.invisibleSender = false;
    }
  }

  class SessionRequest {
    appId: any;
    capabilities: any;
    requestSessionTimeout: any;
    language: any;
    dialRequest: any;
    androidReceiverCompatible: any;
    credentialsData: any;
    constructor(appId: any, capabilities: any = ["video_out", "audio_out"], timeout: any = 60000, androidReceiverCompatible: any = false, credentialsData: any = null) {
      this.appId = appId;
      this.capabilities = capabilities;
      this.requestSessionTimeout = timeout;
      this.language = null;
      this.dialRequest = null;
      this.androidReceiverCompatible = androidReceiverCompatible;
      this.credentialsData = credentialsData;
    }
  }

  class CastError {
    code: any;
    description: any;
    details: any;
    constructor(code: any, description: any = null, details: any = null) {
      this.code = code;
      this.description = description;
      this.details = details;
    }
  }

  class Image {
    url: any;
    height: any;
    width: any;
    constructor(url: any) {
      this.url = url;
      this.height = null;
      this.width = null;
    }
  }

  class Receiver {
    label: any;
    friendlyName: any;
    capabilities: any;
    volume: any;
    receiverType: any;
    isActiveInput: any;
    displayStatus: any;
    constructor(label: any, friendlyName: any, capabilities: any = [], volume: any = null) {
      this.label = label;
      this.friendlyName = friendlyName;
      this.capabilities = capabilities;
      this.volume = volume;
      this.receiverType = "cast";
      this.isActiveInput = null;
      this.displayStatus = null;
    }
  }

  class ReceiverDisplayStatus {
    statusText: any;
    appImages: any;
    constructor(statusText: any, appImages: any) {
      this.statusText = statusText;
      this.appImages = appImages;
    }
  }

  class SenderApplication {
    platform: any;
    url: any;
    packageId: any;
    constructor(platform: any) {
      this.platform = platform;
      this.url = null;
      this.packageId = null;
    }
  }

  class Volume {
    level: any;
    muted: any;
    constructor(level: any = null, muted: any = null) {
      this.level = level;
      this.muted = muted;
    }
  }

  class DialRequest {
    launchUrl: any;
    extraParameters: any;
    constructor(launchUrl: any, extraParameters: any = {}) {
      this.launchUrl = launchUrl;
      this.extraParameters = extraParameters;
    }
  }

  class CredentialsData {
    credentials: any;
    constructor(credentials: any) {
      this.credentials = credentials;
    }
  }

  function safe(fn: any, ...args: any[]): void {
    if (typeof fn !== "function") return;
    try {
      fn(...args);
    } catch (err) {
      console.error(err);
    }
  }

  function fail(error: any, code: string, description?: string): void {
    setTimeout(() => safe(error, new CastError(code, description ?? null)), 0);
  }

  function toImage(img: any): any {
    const out = new Image(img.url);
    if (img.height != null) out.height = img.height;
    if (img.width != null) out.width = img.width;
    return out;
  }

  function toVolume(vol: any): any {
    const out: any = new Volume(vol.level ?? null, vol.muted ?? null);
    if (vol.controlType != null) out.controlType = vol.controlType;
    if (vol.stepInterval != null) out.stepInterval = vol.stepInterval;
    return out;
  }

  function toReceiver(rcv: any): any {
    const out = new Receiver(rcv.label, rcv.friendlyName, Array.isArray(rcv.capabilities) ? [...rcv.capabilities] : [], rcv.volume ? toVolume(rcv.volume) : null);
    if (rcv.isActiveInput != null) out.isActiveInput = rcv.isActiveInput;
    if (rcv.displayStatus) {
      out.displayStatus = new ReceiverDisplayStatus(rcv.displayStatus.statusText, (rcv.displayStatus.appImages ?? []).map(toImage));
    }
    return out;
  }

  function applySnapshot(sess: any, snap: any): void {
    sess.appId = snap.appId;
    sess.displayName = snap.displayName;
    sess.appImages = (snap.appImages ?? []).map(toImage);
    sess.statusText = snap.statusText ?? null;
    sess.namespaces = (snap.namespaces ?? []).map((n: any) => ({ name: n.name }));
    sess.transportId = snap.transportId;
    sess.receiver = toReceiver(snap.receiver);
    if (Array.isArray(snap.senderApps)) {
      sess.senderApps = snap.senderApps.map((a: any) => {
        const sa = new SenderApplication(a.platform);
        if (a.url != null) sa.url = a.url;
        if (a.packageId != null) sa.packageId = a.packageId;
        return sa;
      });
    }
  }

  class Session {
    sessionId: any;
    appId: any;
    displayName: any;
    appImages: any;
    receiver: any;
    senderApps: any[];
    namespaces: any[];
    media: any[];
    status: any;
    statusText: any;
    transportId: any;
    updateListeners: any[];
    messageListeners: Map<string, any[]>;
    constructor(sessionId: any, appId: any, displayName: any, appImages: any, receiver: any) {
      this.sessionId = sessionId;
      this.appId = appId;
      this.displayName = displayName;
      this.appImages = appImages;
      this.receiver = receiver;
      this.senderApps = [];
      this.namespaces = [];
      this.media = [];
      this.status = "connected";
      this.statusText = null;
      this.transportId = sessionId;
      this.updateListeners = [];
      this.messageListeners = new Map<string, any[]>();
    }

    sendMessage(namespace: any, message: any, success?: any, error?: any): void {
      const payload = typeof message === "string" ? message : JSON.stringify(message);
      bridge.call("sendMessage", { sessionId: this.sessionId, namespace, message: payload }).then((res: any) => {
        if (res.ok) {
          safe(success);
          return;
        }
        fail(error, res.code, res.description);
      }).catch((e: unknown) => fail(error, "session_error", String(e)));
    }

    addMessageListener(namespace: any, fn: any): void {
      if (typeof fn !== "function") return;
      let list = this.messageListeners.get(namespace);
      if (!list) {
        list = [];
        this.messageListeners.set(namespace, list);
      }
      if (!list.includes(fn)) list.push(fn);
    }

    removeMessageListener(namespace: any, fn: any): void {
      const list = this.messageListeners.get(namespace);
      if (!list) return;
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    }

    addUpdateListener(fn: any): void {
      if (typeof fn === "function" && !this.updateListeners.includes(fn)) this.updateListeners.push(fn);
    }

    removeUpdateListener(fn: any): void {
      const i = this.updateListeners.indexOf(fn);
      if (i >= 0) this.updateListeners.splice(i, 1);
    }

    addMediaListener(_fn: any): void {}

    removeMediaListener(_fn: any): void {}

    stop(success: any, error: any): void {
      bridge.call("stopSession", { sessionId: this.sessionId }).then((res: any) => {
        if (!res.ok) {
          fail(error, res.code, res.description);
          return;
        }
        this.status = "stopped";
        for (const fn of [...this.updateListeners]) safe(fn, false);
        safe(success);
      }).catch((e: unknown) => fail(error, "session_error", String(e)));
    }

    leave(success: any, error: any): void {
      bridge.call("leaveSession", { sessionId: this.sessionId }).then((res: any) => {
        if (!res.ok) {
          fail(error, res.code, res.description);
          return;
        }
        this.status = "disconnected";
        for (const fn of [...this.updateListeners]) safe(fn, false);
        safe(success);
      }).catch((e: unknown) => fail(error, "session_error", String(e)));
    }

    setReceiverVolumeLevel(level: any, success: any, error: any): void {
      if (typeof level !== "number" || Number.isNaN(level) || level < 0 || level > 1) {
        fail(error, "invalid_parameter");
        return;
      }
      bridge.call("setReceiverVolume", { sessionId: this.sessionId, level }).then((res: any) => {
        if (res.ok) {
          safe(success);
          return;
        }
        fail(error, res.code, res.description);
      }).catch((e: unknown) => fail(error, "session_error", String(e)));
    }

    setReceiverMuted(muted: any, success: any, error: any): void {
      bridge.call("setReceiverMuted", { sessionId: this.sessionId, muted }).then((res: any) => {
        if (res.ok) {
          safe(success);
          return;
        }
        fail(error, res.code, res.description);
      }).catch((e: unknown) => fail(error, "session_error", String(e)));
    }

    loadMedia(_req: any, _success: any, error: any): void {
      fail(error, "session_error", "Media is not supported yet");
    }

    queueLoad(_req: any, _success: any, error: any): void {
      fail(error, "session_error", "Media is not supported yet");
    }
  }

  const sessions = new Map<string, any>();

  function upsertSession(snap: any): any {
    let sess = sessions.get(snap.sessionId);
    if (!sess) {
      sess = new Session(snap.sessionId, snap.appId, snap.displayName, [], toReceiver(snap.receiver));
      sessions.set(snap.sessionId, sess);
    }
    applySnapshot(sess, snap);
    return sess;
  }

  let initialized = false;
  let apiConfig: any = null;
  let pendingRequest = false;
  let lastAvailability: string | null = null;
  const receiverActionListeners: any[] = [];
  const joinedEarly: any[] = [];

  function notifyUpdate(sess: any, alive: boolean): void {
    for (const fn of [...sess.updateListeners]) safe(fn, alive);
  }

  bridge.onEvent((event: BridgeEvent) => {
    switch (event.type) {
      case "receiverAvailability": {
        const value = event.available ? "available" : "unavailable";
        if (value === lastAvailability) return;
        lastAvailability = value;
        if (apiConfig) safe(apiConfig.receiverListener, value);
        return;
      }
      case "sessionJoined": {
        // The main process may rejoin before the initialize reply has been handled here.
        if (apiConfig) safe(apiConfig.sessionListener, upsertSession(event.session));
        else joinedEarly.push(event.session);
        return;
      }
      case "sessionUpdated": {
        const sess = sessions.get(event.session.sessionId);
        if (!sess) return;
        applySnapshot(sess, event.session);
        notifyUpdate(sess, true);
        return;
      }
      case "sessionEnded": {
        const sess = sessions.get(event.sessionId);
        if (!sess) return;
        sess.status = event.status;
        notifyUpdate(sess, false);
        return;
      }
      case "message": {
        const sess = sessions.get(event.sessionId);
        if (!sess) return;
        const fns = sess.messageListeners.get(event.namespace) ?? [];
        for (const fn of [...fns]) safe(fn, event.namespace, event.message);
        return;
      }
    }
  });

  function initialize(apiCfg: any, success: any, error: any): void {
    const req = apiCfg && apiCfg.sessionRequest;
    const valid = !!req && typeof req === "object" && typeof req.appId === "string"
      && typeof apiCfg.sessionListener === "function" && typeof apiCfg.receiverListener === "function";
    if (!valid) {
      fail(error, "invalid_parameter");
      return;
    }
    bridge.call("initialize", {
      appId: req.appId,
      capabilities: Array.isArray(req.capabilities) ? req.capabilities : [],
      autoJoinPolicy: apiCfg.autoJoinPolicy ?? "tab_and_origin_scoped",
    }).then((res: any) => {
      if (!res.ok) {
        fail(error, res.code, res.description);
        return;
      }
      const value = res.value ?? {};
      initialized = true;
      apiConfig = apiCfg;
      const availability = value.available ? "available" : "unavailable";
      lastAvailability = availability;
      safe(success);
      safe(apiCfg.receiverListener, availability);
      for (const snap of [...(value.sessions ?? []), ...joinedEarly.splice(0)]) safe(apiCfg.sessionListener, upsertSession(snap));
    }).catch((e: unknown) => fail(error, "session_error", String(e)));
  }

  function requestSession(success: any, error: any, optSessionRequest?: any): void {
    if (!initialized) {
      fail(error, "api_not_initialized");
      return;
    }
    if (pendingRequest) {
      fail(error, "invalid_parameter");
      return;
    }
    const req = optSessionRequest ?? apiConfig.sessionRequest;
    pendingRequest = true;
    bridge.call("requestSession", {
      appId: req.appId,
      capabilities: Array.isArray(req.capabilities) ? req.capabilities : [],
      timeoutMs: req.requestSessionTimeout ?? 60000,
    }).then((res: any) => {
      pendingRequest = false;
      if (!res.ok) {
        fail(error, res.code, res.description);
        return;
      }
      const sess = upsertSession(res.value);
      for (const fn of [...receiverActionListeners]) safe(fn, sess.receiver, ReceiverAction.CAST);
      safe(success, sess);
    }).catch((e: unknown) => {
      pendingRequest = false;
      fail(error, "session_error", String(e));
    });
  }

  function requestSessionById(sessionId: any): void {
    bridge.call("joinSession", { sessionId }).then((res: any) => {
      if (!res.ok) return;
      const sess = upsertSession(res.value);
      if (apiConfig) safe(apiConfig.sessionListener, sess);
    }).catch((e: unknown) => console.error(e));
  }

  function addReceiverActionListener(fn: any): void {
    if (typeof fn === "function" && !receiverActionListeners.includes(fn)) receiverActionListeners.push(fn);
  }

  function removeReceiverActionListener(fn: any): void {
    const i = receiverActionListeners.indexOf(fn);
    if (i >= 0) receiverActionListeners.splice(i, 1);
  }

  function setCustomReceivers(_receivers: any, success: any, _error: any): void {
    setTimeout(() => safe(success), 0);
  }

  function setReceiverDisplayStatus(_receiver: any, success: any, _error: any): void {
    setTimeout(() => safe(success), 0);
  }

  function logMessage(_msg: any): void {}

  function precache(_data: any): void {}

  function unescape(s: any): any {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  }

  g.chrome.cast = {
    VERSION,
    isAvailable: true,
    AutoJoinPolicy,
    Capability,
    DefaultActionPolicy,
    DialAppState,
    ErrorCode,
    ReceiverAction,
    ReceiverAvailability,
    ReceiverType,
    SenderPlatform,
    SessionStatus,
    VolumeControlType,
    timeout: new Timeout(),
    media,
    ApiConfig,
    SessionRequest,
    Error: CastError,
    Image,
    Receiver,
    ReceiverDisplayStatus,
    SenderApplication,
    Volume,
    Timeout,
    DialRequest,
    CredentialsData,
    Session,
    initialize,
    requestSession,
    requestSessionById,
    addReceiverActionListener,
    removeReceiverActionListener,
    setCustomReceivers,
    setReceiverDisplayStatus,
    logMessage,
    precache,
    unescape,
  };

  let onGCastApiAvailable: any = g.__onGCastApiAvailable;
  const notifyGCastApiAvailable = (): void => {
    setTimeout(() => safe(onGCastApiAvailable, true), 0);
  };
  if (typeof onGCastApiAvailable === "function") notifyGCastApiAvailable();
  Object.defineProperty(g, "__onGCastApiAvailable", {
    configurable: true,
    enumerable: true,
    get: () => onGCastApiAvailable,
    set: (v: any) => {
      onGCastApiAvailable = v;
      if (typeof v === "function") notifyGCastApiAvailable();
    },
  });

  return true;
}
