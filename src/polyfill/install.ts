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
  const MEDIA_NAMESPACE = "urn:x-cast:com.google.cast.media";

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

  const PlayerState = { IDLE: "IDLE", PLAYING: "PLAYING", PAUSED: "PAUSED", BUFFERING: "BUFFERING" };
  const MediaCommand = { PAUSE: "pause", SEEK: "seek", STREAM_VOLUME: "stream_volume", STREAM_MUTE: "stream_mute" };
  const MetadataType = { GENERIC: 0, MOVIE: 1, TV_SHOW: 2, MUSIC_TRACK: 3, PHOTO: 4 };
  const RepeatMode = { OFF: "REPEAT_OFF", ALL: "REPEAT_ALL", SINGLE: "REPEAT_SINGLE", ALL_AND_SHUFFLE: "REPEAT_ALL_AND_SHUFFLE" };
  const ResumeState = { PLAYBACK_START: "PLAYBACK_START", PLAYBACK_PAUSE: "PLAYBACK_PAUSE" };
  const StreamType = { BUFFERED: "BUFFERED", LIVE: "LIVE", OTHER: "OTHER" };
  const IdleReason = { CANCELLED: "CANCELLED", INTERRUPTED: "INTERRUPTED", FINISHED: "FINISHED", ERROR: "ERROR" };
  const TrackType = { TEXT: "TEXT", AUDIO: "AUDIO", VIDEO: "VIDEO" };
  const TextTrackType = { SUBTITLES: "SUBTITLES", CAPTIONS: "CAPTIONS", DESCRIPTIONS: "DESCRIPTIONS", CHAPTERS: "CHAPTERS", METADATA: "METADATA" };
  const TextTrackEdgeType = { NONE: "NONE", OUTLINE: "OUTLINE", DROP_SHADOW: "DROP_SHADOW", RAISED: "RAISED", DEPRESSED: "DEPRESSED" };
  const TextTrackWindowType = { NONE: "NONE", NORMAL: "NORMAL", ROUNDED_CORNERS: "ROUNDED_CORNERS" };
  const TextTrackFontGenericFamily = { SANS_SERIF: "SANS_SERIF", MONOSPACED_SANS_SERIF: "MONOSPACED_SANS_SERIF", SERIF: "SERIF", MONOSPACED_SERIF: "MONOSPACED_SERIF", CASUAL: "CASUAL", CURSIVE: "CURSIVE", SMALL_CAPITALS: "SMALL_CAPITALS" };
  const TextTrackFontStyle = { NORMAL: "NORMAL", BOLD: "BOLD", BOLD_ITALIC: "BOLD_ITALIC", ITALIC: "ITALIC" };

  class MediaInfo {
    contentId: any;
    streamType: any;
    contentType: any;
    metadata: any;
    duration: any;
    tracks: any;
    textTrackStyle: any;
    customData: any;
    constructor(contentId: any, contentType: any) {
      this.contentId = contentId;
      this.streamType = "BUFFERED";
      this.contentType = contentType;
      this.metadata = null;
      this.duration = null;
      this.tracks = null;
      this.textTrackStyle = null;
      this.customData = null;
    }
  }

  class LoadRequest {
    type: any;
    requestId: any;
    sessionId: any;
    media: any;
    activeTrackIds: any;
    autoplay: any;
    currentTime: any;
    customData: any;
    constructor(media: any) {
      this.type = "LOAD";
      this.requestId = 0;
      this.sessionId = null;
      this.media = media;
      this.activeTrackIds = null;
      this.autoplay = true;
      this.currentTime = null;
      this.customData = null;
    }
  }

  class QueueItem {
    itemId: any;
    media: any;
    autoplay: any;
    startTime: any;
    playbackDuration: any;
    preloadTime: any;
    activeTrackIds: any;
    customData: any;
    constructor(media: any) {
      this.itemId = null;
      this.media = media;
      this.autoplay = true;
      this.startTime = 0;
      this.playbackDuration = null;
      this.preloadTime = 0;
      this.activeTrackIds = null;
      this.customData = null;
    }
  }

  class QueueLoadRequest {
    type: any;
    requestId: any;
    sessionId: any;
    items: any;
    startIndex: any;
    repeatMode: any;
    customData: any;
    constructor(items: any) {
      this.type = "QUEUE_LOAD";
      this.requestId = null;
      this.sessionId = null;
      this.items = items;
      this.startIndex = 0;
      this.repeatMode = "REPEAT_OFF";
      this.customData = null;
    }
  }

  class QueueInsertItemsRequest {
    type: any;
    requestId: any;
    sessionId: any;
    items: any;
    insertBefore: any;
    customData: any;
    constructor(items: any) {
      this.type = "QUEUE_INSERT";
      this.requestId = null;
      this.sessionId = null;
      this.items = items;
      this.insertBefore = null;
      this.customData = null;
    }
  }

  class QueueRemoveItemsRequest {
    type: any;
    requestId: any;
    sessionId: any;
    itemIds: any;
    customData: any;
    constructor(itemIds: any) {
      this.type = "QUEUE_REMOVE";
      this.requestId = null;
      this.sessionId = null;
      this.itemIds = itemIds;
      this.customData = null;
    }
  }

  class QueueReorderItemsRequest {
    type: any;
    requestId: any;
    sessionId: any;
    itemIds: any;
    insertBefore: any;
    customData: any;
    constructor(itemIds: any) {
      this.type = "QUEUE_REORDER";
      this.requestId = null;
      this.sessionId = null;
      this.itemIds = itemIds;
      this.insertBefore = null;
      this.customData = null;
    }
  }

  class QueueUpdateItemsRequest {
    type: any;
    requestId: any;
    sessionId: any;
    items: any;
    customData: any;
    constructor(items: any) {
      this.type = "QUEUE_UPDATE";
      this.requestId = null;
      this.sessionId = null;
      this.items = items;
      this.customData = null;
    }
  }

  class QueueSetPropertiesRequest {
    type: any;
    requestId: any;
    sessionId: any;
    repeatMode: any;
    customData: any;
    constructor() {
      this.type = "QUEUE_UPDATE";
      this.requestId = null;
      this.sessionId = null;
      this.repeatMode = null;
      this.customData = null;
    }
  }

  class QueueJumpRequest {
    type: any;
    requestId: any;
    sessionId: any;
    currentItemId: any;
    jump: any;
    customData: any;
    constructor() {
      this.type = "QUEUE_UPDATE";
      this.requestId = null;
      this.sessionId = null;
      this.currentItemId = null;
      this.jump = null;
      this.customData = null;
    }
  }

  class SeekRequest {
    currentTime: any;
    resumeState: any;
    customData: any;
    constructor() {
      this.currentTime = null;
      this.resumeState = null;
      this.customData = null;
    }
  }

  class VolumeRequest {
    volume: any;
    customData: any;
    constructor(volume: any) {
      this.volume = volume;
      this.customData = null;
    }
  }

  class PlayRequest {
    customData: any;
    constructor() {
      this.customData = null;
    }
  }

  class PauseRequest {
    customData: any;
    constructor() {
      this.customData = null;
    }
  }

  class StopRequest {
    customData: any;
    constructor() {
      this.customData = null;
    }
  }

  class GetStatusRequest {
    customData: any;
    constructor() {
      this.customData = null;
    }
  }

  class EditTracksInfoRequest {
    requestId: any;
    activeTrackIds: any;
    textTrackStyle: any;
    constructor(activeTrackIds: any, textTrackStyle: any) {
      this.requestId = 0;
      this.activeTrackIds = activeTrackIds ?? null;
      this.textTrackStyle = textTrackStyle ?? null;
    }
  }

  class Track {
    trackId: any;
    trackContentId: any;
    trackContentType: any;
    type: any;
    name: any;
    language: any;
    subtype: any;
    customData: any;
    constructor(trackId: any, type: any) {
      this.trackId = trackId;
      this.trackContentId = null;
      this.trackContentType = null;
      this.type = type;
      this.name = null;
      this.language = null;
      this.subtype = null;
      this.customData = null;
    }
  }

  class TextTrackStyle {
    foregroundColor: any;
    backgroundColor: any;
    edgeType: any;
    edgeColor: any;
    windowType: any;
    windowColor: any;
    windowRoundedCornerRadius: any;
    fontScale: any;
    fontFamily: any;
    fontGenericFamily: any;
    fontStyle: any;
    customData: any;
    constructor() {
      this.foregroundColor = null;
      this.backgroundColor = null;
      this.edgeType = null;
      this.edgeColor = null;
      this.windowType = null;
      this.windowColor = null;
      this.windowRoundedCornerRadius = null;
      this.fontScale = null;
      this.fontFamily = null;
      this.fontGenericFamily = null;
      this.fontStyle = null;
      this.customData = null;
    }
  }

  class GenericMediaMetadata {
    type: any;
    metadataType: any;
    title: any;
    subtitle: any;
    images: any;
    releaseYear: any;
    releaseDate: any;
    constructor() {
      this.type = 0;
      this.metadataType = 0;
      this.title = null;
      this.subtitle = null;
      this.images = null;
      this.releaseYear = null;
      this.releaseDate = null;
    }
  }

  class MovieMediaMetadata {
    type: any;
    metadataType: any;
    title: any;
    studio: any;
    subtitle: any;
    images: any;
    releaseYear: any;
    releaseDate: any;
    constructor() {
      this.type = 1;
      this.metadataType = 1;
      this.title = null;
      this.studio = null;
      this.subtitle = null;
      this.images = null;
      this.releaseYear = null;
      this.releaseDate = null;
    }
  }

  class TvShowMediaMetadata {
    type: any;
    metadataType: any;
    seriesTitle: any;
    title: any;
    episodeTitle: any;
    seasonNumber: any;
    season: any;
    episodeNumber: any;
    episode: any;
    images: any;
    releaseYear: any;
    originalAirdate: any;
    constructor() {
      this.type = 2;
      this.metadataType = 2;
      this.seriesTitle = null;
      this.title = null;
      this.episodeTitle = null;
      this.seasonNumber = null;
      this.season = null;
      this.episodeNumber = null;
      this.episode = null;
      this.images = null;
      this.releaseYear = null;
      this.originalAirdate = null;
    }
  }

  class MusicTrackMediaMetadata {
    type: any;
    metadataType: any;
    albumName: any;
    title: any;
    albumArtist: any;
    artist: any;
    composer: any;
    songName: any;
    artistName: any;
    trackNumber: any;
    discNumber: any;
    images: any;
    releaseYear: any;
    releaseDate: any;
    constructor() {
      this.type = 3;
      this.metadataType = 3;
      this.albumName = null;
      this.title = null;
      this.albumArtist = null;
      this.artist = null;
      this.composer = null;
      this.songName = null;
      this.artistName = null;
      this.trackNumber = null;
      this.discNumber = null;
      this.images = null;
      this.releaseYear = null;
      this.releaseDate = null;
    }
  }

  class PhotoMediaMetadata {
    type: any;
    metadataType: any;
    title: any;
    artist: any;
    location: any;
    images: any;
    latitude: any;
    longitude: any;
    width: any;
    height: any;
    creationDateTime: any;
    constructor() {
      this.type = 4;
      this.metadataType = 4;
      this.title = null;
      this.artist = null;
      this.location = null;
      this.images = null;
      this.latitude = null;
      this.longitude = null;
      this.width = null;
      this.height = null;
      this.creationDateTime = null;
    }
  }

  class Media {
    sessionId: any;
    mediaSessionId: any;
    media: any;
    playbackRate: any;
    playerState: any;
    currentTime: any;
    supportedMediaCommands: any[];
    volume: any;
    idleReason: any;
    activeTrackIds: any;
    customData: any;
    currentItemId: any;
    loadingItemId: any;
    preloadedItemId: any;
    items: any;
    repeatMode: any;
    liveSeekableRange: any;
    breakStatus: any;
    videoInfo: any;
    queueData: any;
    _updateListeners: any[];
    _lastUpdate: number;
    _announced: boolean;
    constructor(sessionId: any, mediaSessionId: any) {
      this.sessionId = sessionId;
      this.mediaSessionId = mediaSessionId;
      this.media = null;
      this.playbackRate = 1;
      this.playerState = "IDLE";
      this.currentTime = 0;
      this.supportedMediaCommands = [];
      this.volume = new Volume();
      this.idleReason = null;
      this.activeTrackIds = null;
      this.customData = null;
      this.currentItemId = null;
      this.loadingItemId = null;
      this.preloadedItemId = null;
      this.items = null;
      this.repeatMode = "REPEAT_OFF";
      this.liveSeekableRange = null;
      this.breakStatus = null;
      this.videoInfo = null;
      this.queueData = null;
      this._updateListeners = [];
      this._lastUpdate = 0;
      this._announced = false;
    }

    addUpdateListener(fn: any): void {
      if (typeof fn === "function" && !this._updateListeners.includes(fn)) this._updateListeners.push(fn);
    }

    removeUpdateListener(fn: any): void {
      const i = this._updateListeners.indexOf(fn);
      if (i >= 0) this._updateListeners.splice(i, 1);
    }

    supportsCommand(cmd: any): boolean {
      return this.supportedMediaCommands.includes(cmd);
    }

    getEstimatedTime(): any {
      if (this.playerState === "PLAYING") {
        let t = this.currentTime + this.playbackRate * (Date.now() - this._lastUpdate) / 1000;
        const duration = this.media && this.media.duration;
        if (typeof duration === "number") t = Math.min(t, duration);
        return t;
      }
      return this.currentTime;
    }

    getEstimatedBreakTime(): any {
      const base = this.breakStatus && this.breakStatus.currentBreakTime;
      if (typeof base !== "number") return undefined;
      return base + this._estimateElapsed();
    }

    getEstimatedBreakClipTime(): any {
      const base = this.breakStatus && this.breakStatus.currentBreakClipTime;
      if (typeof base !== "number") return undefined;
      return base + this._estimateElapsed();
    }

    getEstimatedLiveSeekableRange(): any {
      const r = this.liveSeekableRange;
      if (r == null) return undefined;
      const elapsed = this._estimateElapsed();
      const out: any = {
        start: r.start,
        end: r.end,
        isMovingWindow: r.isMovingWindow,
        isLiveDone: r.isLiveDone,
      };
      if (r.isLiveDone !== true) {
        if (typeof out.end === "number") out.end += elapsed;
        if (r.isMovingWindow === true && typeof out.start === "number") out.start += elapsed;
      }
      return out;
    }

    /** Seconds advanced since the last status update: playbackRate * elapsed while PLAYING, else 0. */
    _estimateElapsed(): number {
      if (this.playerState !== "PLAYING") return 0;
      return this.playbackRate * (Date.now() - this._lastUpdate) / 1000;
    }

    /** Send a command on the media namespace; resolves with no arguments on the matching MEDIA_STATUS. */
    sendCommand(type: string, extra: any, success: any, error: any): void {
      const sess = sessions.get(this.sessionId);
      if (!sess || sess.status !== "connected") {
        fail(error, "session_error");
        return;
      }
      const requestId = nextRequestId();
      const message = stripNulls({ type, requestId, mediaSessionId: this.mediaSessionId, ...extra });
      sendMediaRequest(sess, requestId, message, MEDIA_TIMEOUT_KEYS[type] ?? "getStatus", success, error);
    }

    getStatus(req: any, success: any, error: any): void {
      this.sendCommand("GET_STATUS", { customData: req?.customData ?? null }, success, error);
    }

    play(req: any, success: any, error: any): void {
      this.sendCommand("PLAY", { customData: req?.customData ?? null }, success, error);
    }

    pause(req: any, success: any, error: any): void {
      this.sendCommand("PAUSE", { customData: req?.customData ?? null }, success, error);
    }

    seek(seekRequest: any, success: any, error: any): void {
      this.sendCommand("SEEK", {
        currentTime: seekRequest?.currentTime ?? null,
        resumeState: seekRequest?.resumeState ?? null,
        customData: seekRequest?.customData ?? null,
      }, success, error);
    }

    stop(req: any, success: any, error: any): void {
      this.sendCommand("STOP", { customData: req?.customData ?? null }, success, error);
    }

    setVolume(volumeRequest: any, success: any, error: any): void {
      const vol = volumeRequest?.volume;
      this.sendCommand("SET_VOLUME", {
        volume: vol ? { level: vol.level ?? null, muted: vol.muted ?? null } : null,
        customData: volumeRequest?.customData ?? null,
      }, success, error);
    }

    editTracksInfo(req: any, success: any, error: any): void {
      this.sendCommand("EDIT_TRACKS_INFO", {
        activeTrackIds: req?.activeTrackIds ?? null,
        textTrackStyle: req?.textTrackStyle ?? null,
      }, success, error);
    }

    queueInsertItems(req: any, success: any, error: any): void {
      this.sendCommand("QUEUE_INSERT", {
        items: req?.items ?? null,
        insertBefore: req?.insertBefore ?? null,
        customData: req?.customData ?? null,
      }, success, error);
    }

    queueAppendItem(item: any, success: any, error: any): void {
      this.sendCommand("QUEUE_INSERT", { items: [item] }, success, error);
    }

    queueUpdateItems(req: any, success: any, error: any): void {
      this.sendCommand("QUEUE_UPDATE", {
        items: req?.items ?? null,
        customData: req?.customData ?? null,
      }, success, error);
    }

    queueJumpToItem(itemId: any, success: any, error: any): void {
      this.sendCommand("QUEUE_UPDATE", { currentItemId: itemId }, success, error);
    }

    queueNext(success: any, error: any): void {
      this.sendCommand("QUEUE_UPDATE", { jump: 1 }, success, error);
    }

    queuePrev(success: any, error: any): void {
      this.sendCommand("QUEUE_UPDATE", { jump: -1 }, success, error);
    }

    queueSetRepeatMode(mode: any, success: any, error: any): void {
      this.sendCommand("QUEUE_UPDATE", { repeatMode: mode }, success, error);
    }

    queueRemoveItems(req: any, success: any, error: any): void {
      this.sendCommand("QUEUE_REMOVE", {
        itemIds: req?.itemIds ?? null,
        customData: req?.customData ?? null,
      }, success, error);
    }

    queueRemoveItem(itemId: any, success: any, error: any): void {
      this.sendCommand("QUEUE_REMOVE", { itemIds: [itemId] }, success, error);
    }

    queueReorderItems(req: any, success: any, error: any): void {
      this.sendCommand("QUEUE_REORDER", {
        itemIds: req?.itemIds ?? null,
        insertBefore: req?.insertBefore ?? null,
        customData: req?.customData ?? null,
      }, success, error);
    }

    queueMoveItemToNewIndex(itemId: any, newIndex: any, success: any, error: any): void {
      const items = Array.isArray(this.items) ? this.items : null;
      if (!items || !items.some((i: any) => i && i.itemId === itemId) || !Number.isInteger(newIndex) || newIndex < 0) {
        fail(error, "invalid_parameter");
        return;
      }
      const remaining = items.map((i: any) => i.itemId).filter((id: any) => id !== itemId);
      const extra = newIndex >= remaining.length
        ? { itemIds: [itemId] }
        : { itemIds: [itemId], insertBefore: remaining[newIndex] };
      this.sendCommand("QUEUE_REORDER", extra, success, error);
    }
  }

  const media = {
    DEFAULT_MEDIA_RECEIVER_APP_ID: "CC1AD845",
    PlayerState,
    MediaCommand,
    MetadataType,
    RepeatMode,
    ResumeState,
    StreamType,
    IdleReason,
    TrackType,
    TextTrackType,
    TextTrackEdgeType,
    TextTrackWindowType,
    TextTrackFontGenericFamily,
    TextTrackFontStyle,
    timeout: { load: 15000, getStatus: 15000, play: 15000, pause: 15000, seek: 15000, stop: 15000, setVolume: 15000, editTracksInfo: 15000, queue: 15000 },
    MediaInfo,
    LoadRequest,
    QueueItem,
    QueueLoadRequest,
    QueueInsertItemsRequest,
    QueueRemoveItemsRequest,
    QueueReorderItemsRequest,
    QueueUpdateItemsRequest,
    QueueSetPropertiesRequest,
    QueueJumpRequest,
    SeekRequest,
    VolumeRequest,
    PlayRequest,
    PauseRequest,
    StopRequest,
    GetStatusRequest,
    EditTracksInfoRequest,
    Track,
    TextTrackStyle,
    GenericMediaMetadata,
    MovieMediaMetadata,
    TvShowMediaMetadata,
    MusicTrackMediaMetadata,
    PhotoMediaMetadata,
    Media,
  };

  const MEDIA_TIMEOUT_KEYS: Record<string, string> = {
    LOAD: "load",
    GET_STATUS: "getStatus",
    PLAY: "play",
    PAUSE: "pause",
    SEEK: "seek",
    STOP: "stop",
    SET_VOLUME: "setVolume",
    EDIT_TRACKS_INFO: "editTracksInfo",
    QUEUE_LOAD: "queue",
    QUEUE_INSERT: "queue",
    QUEUE_REMOVE: "queue",
    QUEUE_REORDER: "queue",
    QUEUE_UPDATE: "queue",
  };

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

  const REQ_ID_MAX = 2 ** 30;
  let requestIdCounter = Math.floor(Math.random() * (REQ_ID_MAX - 1)) + 1;

  /** Positive integer requestIds, unique within the page, starting at a random value in [1, 2^30). */
  function nextRequestId(): number {
    const id = requestIdCounter;
    requestIdCounter += 1;
    if (requestIdCounter >= REQ_ID_MAX) requestIdCounter = 1;
    return id;
  }

  /** A timer that does not keep a Node test process alive; plain in the browser. */
  function later(ms: number, fn: () => void): any {
    const t: any = setTimeout(fn, ms);
    if (t && typeof t.unref === "function") t.unref();
    return t;
  }

  /** Remove every key whose value is null or undefined, recursively through objects and arrays. */
  function stripNulls(value: any): any {
    if (Array.isArray(value)) return value.map(stripNulls).filter((v: any) => v !== null && v !== undefined);
    if (value && typeof value === "object") {
      const out: any = {};
      for (const key of Object.keys(value)) {
        const v = value[key];
        if (v === null || v === undefined) continue;
        out[key] = stripNulls(v);
      }
      return out;
    }
    return value;
  }

  function settlePendingMedia(sess: any, requestId: number, outcome: () => void): void {
    const p = sess._pendingMedia.get(requestId);
    if (!p) return;
    sess._pendingMedia.delete(requestId);
    if (p.timer) clearTimeout(p.timer);
    outcome();
  }

  /** Send one media-namespace message and track it until its reply (or timeout) arrives. */
  function sendMediaRequest(sess: any, requestId: number, message: any, timeoutKey: string, success: any, error: any): void {
    const pending: any = { kind: message.type, success, error, timer: null };
    const timeoutMs = (media.timeout as Record<string, number>)[timeoutKey];
    if (typeof timeoutMs === "number" && timeoutMs > 0) {
      pending.timer = later(timeoutMs, () => settlePendingMedia(sess, requestId, () => fail(error, "timeout")));
    }
    sess._pendingMedia.set(requestId, pending);
    bridge.call("sendMessage", { sessionId: sess.sessionId, namespace: MEDIA_NAMESPACE, message: JSON.stringify(message) })
      .then((res: any) => {
        if (!res.ok) settlePendingMedia(sess, requestId, () => fail(error, res.code, res.description));
      })
      .catch((e: unknown) => settlePendingMedia(sess, requestId, () => fail(error, "session_error", String(e))));
  }

  /** Kill every Media of the session (update listeners get false) without touching pending requests. */
  function killAllMedia(sess: any): void {
    for (const m of [...sess.media]) {
      for (const fn of [...m._updateListeners]) safe(fn, false);
    }
    sess.media = [];
  }

  /** The session is gone: kill its media and fail every pending media request with session_error. */
  function killSessionMedia(sess: any): void {
    killAllMedia(sess);
    for (const p of [...sess._pendingMedia.values()]) {
      if (p.timer) clearTimeout(p.timer);
      fail(p.error, "session_error");
    }
    sess._pendingMedia.clear();
  }

  function applyMediaStatus(sess: any, msg: any): void {
    const entries: any[] = Array.isArray(msg.status) ? msg.status : msg.status && typeof msg.status === "object" ? [msg.status] : [];
    if (entries.length === 0) {
      killAllMedia(sess);
      return;
    }
    const pending = typeof msg.requestId === "number" ? sess._pendingMedia.get(msg.requestId) : undefined;
    const suppressAnnounce = !!pending && (pending.kind === "LOAD" || pending.kind === "QUEUE_LOAD");
    for (const e of entries) {
      if (!e || typeof e !== "object" || e.mediaSessionId == null) continue;
      let m = sess.media.find((x: any) => x.mediaSessionId === e.mediaSessionId);
      const isNew = !m;
      if (isNew) {
        m = new Media(sess.sessionId, e.mediaSessionId);
        sess.media.push(m);
      }
      if (e.media != null) m.media = e.media;
      if (e.playbackRate != null) m.playbackRate = e.playbackRate;
      if (e.playerState != null) m.playerState = e.playerState;
      if (e.currentTime != null) m.currentTime = e.currentTime;
      if (e.activeTrackIds != null) m.activeTrackIds = e.activeTrackIds;
      if (e.customData != null) m.customData = e.customData;
      if (e.currentItemId != null) m.currentItemId = e.currentItemId;
      if (e.loadingItemId != null) m.loadingItemId = e.loadingItemId;
      if (e.preloadedItemId != null) m.preloadedItemId = e.preloadedItemId;
      if (e.items != null) m.items = e.items;
      if (e.repeatMode != null) m.repeatMode = e.repeatMode;
      // A MEDIA_STATUS entry is the receiver's full status except that unchanged fields may be left out:
      // an ad break that ended, or a stream that is no longer live, drops the field, so these default to null.
      m.liveSeekableRange = e.liveSeekableRange ?? null;
      m.breakStatus = e.breakStatus ?? null;
      if (e.videoInfo != null) m.videoInfo = e.videoInfo;
      if (e.queueData != null) m.queueData = e.queueData;
      m.idleReason = e.idleReason ?? null;
      if (e.volume != null) m.volume = new Volume(e.volume.level ?? null, e.volume.muted ?? null);
      if (e.supportedMediaCommands != null) {
        const bits = [MediaCommand.PAUSE, MediaCommand.SEEK, MediaCommand.STREAM_VOLUME, MediaCommand.STREAM_MUTE];
        m.supportedMediaCommands = bits.filter((_: any, i: number) => (e.supportedMediaCommands & (1 << i)) !== 0);
      }
      m._lastUpdate = Date.now();
      const alive = !(m.playerState === PlayerState.IDLE && m.idleReason !== null);
      for (const fn of [...m._updateListeners]) safe(fn, alive);
      if (!alive) {
        const i = sess.media.indexOf(m);
        if (i >= 0) sess.media.splice(i, 1);
      } else if (isNew && !m._announced) {
        m._announced = true;
        if (!suppressAnnounce) for (const fn of [...sess._mediaListeners]) safe(fn, m);
      }
    }
  }

  /** Resolve a pending media request from a reply on the media namespace. */
  function resolveMediaReply(sess: any, msg: any): void {
    if (!msg || typeof msg !== "object" || typeof msg.requestId !== "number") return;
    const p = sess._pendingMedia.get(msg.requestId);
    if (!p) return;
    switch (msg.type) {
      case "MEDIA_STATUS": {
        if (p.kind === "LOAD" || p.kind === "QUEUE_LOAD") {
          // Some receivers (a Nest Hub) answer a LOAD with an interim MEDIA_STATUS whose entry still
          // reports extendedStatus.playerState "LOADING"; keep waiting for the final status.
          const entries: any[] = Array.isArray(msg.status) ? msg.status : msg.status && typeof msg.status === "object" ? [msg.status] : [];
          const interim = entries.some((e: any) => e && e.extendedStatus && e.extendedStatus.playerState === "LOADING");
          if (interim) return;
          const first = Array.isArray(msg.status) ? msg.status[0] : msg.status;
          const m = first && sess.media.find((x: any) => x.mediaSessionId === first.mediaSessionId);
          settlePendingMedia(sess, msg.requestId, () => (m ? safe(p.success, m) : fail(p.error, "load_media_failed")));
        } else {
          settlePendingMedia(sess, msg.requestId, () => safe(p.success));
        }
        return;
      }
      case "LOAD_FAILED":
        settlePendingMedia(sess, msg.requestId, () => fail(p.error, "load_media_failed"));
        return;
      case "LOAD_CANCELLED":
        settlePendingMedia(sess, msg.requestId, () => fail(p.error, "cancel"));
        return;
      case "INVALID_REQUEST":
      case "INVALID_PLAYER_STATE":
        settlePendingMedia(sess, msg.requestId, () => fail(p.error, "session_error", msg.reason));
        return;
    }
  }

  function handleMediaMessage(sess: any, raw: any): void {
    let msg: any;
    try {
      msg = typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "MEDIA_STATUS") applyMediaStatus(sess, msg);
    resolveMediaReply(sess, msg);
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
    _mediaListeners: any[];
    _pendingMedia: Map<number, any>;
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
      this._mediaListeners = [];
      this._pendingMedia = new Map<number, any>();
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

    addMediaListener(fn: any): void {
      if (typeof fn === "function" && !this._mediaListeners.includes(fn)) this._mediaListeners.push(fn);
    }

    removeMediaListener(fn: any): void {
      const i = this._mediaListeners.indexOf(fn);
      if (i >= 0) this._mediaListeners.splice(i, 1);
    }

    stop(success: any, error: any): void {
      bridge.call("stopSession", { sessionId: this.sessionId }).then((res: any) => {
        if (!res.ok) {
          fail(error, res.code, res.description);
          return;
        }
        endSession(this, "stopped");
        safe(success);
      }).catch((e: unknown) => fail(error, "session_error", String(e)));
    }

    leave(success: any, error: any): void {
      bridge.call("leaveSession", { sessionId: this.sessionId }).then((res: any) => {
        if (!res.ok) {
          fail(error, res.code, res.description);
          return;
        }
        endSession(this, "disconnected");
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

    loadMedia(req: any, success: any, error: any): void {
      if (!req || typeof req !== "object" || !req.media) {
        fail(error, "invalid_parameter");
        return;
      }
      if (this.status !== "connected") {
        fail(error, "session_error");
        return;
      }
      const requestId = nextRequestId();
      const message = stripNulls({
        type: "LOAD",
        requestId,
        sessionId: this.sessionId,
        media: req.media,
        autoplay: req.autoplay ?? true,
        currentTime: req.currentTime ?? null,
        activeTrackIds: req.activeTrackIds ?? null,
        customData: req.customData ?? null,
      });
      sendMediaRequest(this, requestId, message, "load", success, error);
    }

    queueLoad(req: any, success: any, error: any): void {
      if (!req || typeof req !== "object" || !Array.isArray(req.items)) {
        fail(error, "invalid_parameter");
        return;
      }
      if (this.status !== "connected") {
        fail(error, "session_error");
        return;
      }
      const requestId = nextRequestId();
      const message = stripNulls({
        type: "QUEUE_LOAD",
        requestId,
        sessionId: this.sessionId,
        items: req.items,
        startIndex: req.startIndex ?? 0,
        repeatMode: req.repeatMode ?? "REPEAT_OFF",
        customData: req.customData ?? null,
      });
      sendMediaRequest(this, requestId, message, "queue", success, error);
    }
  }

  const sessions = new Map<string, any>();

  /** End a session: notify, then drop it from the session map so later events for it are ignored. */
  function endSession(sess: any, status: string): void {
    sess.status = status;
    killSessionMedia(sess);
    notifyUpdate(sess, false);
    sessions.delete(sess.sessionId);
  }

  /**
   * Report a session to a sessionListener function at most once: remember, per listener function, the
   * session ids already announced to it, so a second initialize (or a requestSessionById) does not
   * re-announce a session that function already got.
   */
  const announcedTo = new WeakMap<any, Set<string>>();
  function announce(sess: any, listener: any): void {
    if (!sess || typeof listener !== "function") return;
    let set = announcedTo.get(listener);
    if (!set) {
      set = new Set<string>();
      announcedTo.set(listener, set);
    }
    if (set.has(sess.sessionId)) return;
    set.add(sess.sessionId);
    safe(listener, sess);
  }

  function upsertSession(snap: any): any {
    let sess = sessions.get(snap.sessionId);
    const created = !sess;
    if (created) {
      sess = new Session(snap.sessionId, snap.appId, snap.displayName, [], toReceiver(snap.receiver));
      sessions.set(snap.sessionId, sess);
    }
    applySnapshot(sess, snap);
    if (created && sess.namespaces.some((n: any) => n.name === MEDIA_NAMESPACE)) {
      // Discover media the receiver already has; its failure is ignored.
      const requestId = nextRequestId();
      sendMediaRequest(sess, requestId, { type: "GET_STATUS", requestId }, "getStatus", () => {}, () => {});
    }
    return sess;
  }

  let initialized = false;
  let apiConfig: any = null;
  let pendingRequest = false;
  let lastAvailability: string | null = null;
  const receiverActionListeners: any[] = [];

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
        endSession(sess, event.status);
        return;
      }
      case "receiverAction": {
        // A live session only: unknown ids and sessions that already ended are ignored.
        const sess = sessions.get(event.sessionId);
        if (!sess) return;
        for (const fn of [...receiverActionListeners]) safe(fn, sess.receiver, ReceiverAction.STOP);
        return;
      }
      case "message": {
        const sess = sessions.get(event.sessionId);
        if (!sess) return;
        const fns = sess.messageListeners.get(event.namespace) ?? [];
        for (const fn of [...fns]) safe(fn, event.namespace, event.message);
        if (event.namespace === MEDIA_NAMESPACE) handleMediaMessage(sess, event.message);
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
      for (const snap of value.sessions ?? []) announce(upsertSession(snap), apiCfg.sessionListener);
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
      if (apiConfig) announce(sess, apiConfig.sessionListener);
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

  // Google's cast_sender.js loader (it takes the desktop-Chrome path because Electron exposes
  // navigator.presentation) injects its own chrome.cast implementations from gstatic/eureka/clank and
  // from the two Cast extensions. The first one that loads would overwrite this polyfill with an
  // implementation on the Presentation API, which finds no devices in Electron, so those scripts are
  // blocked before they can load. A blocked element ends up with no src, so it never fires load or
  // error and the loader's chain simply stops there.
  const blockedClankRe = /^(https?:)?\/\/www\.gstatic\.com\/eureka\/clank\/(\d+\/)?cast_sender\.js/i;
  const blockedExtensionRe = /^chrome-extension:\/\/(pkedcjkdefgpdelpbcmbmeomcjbeemfm|enhhojjnijigcajfphajepfemndkmdlo)\//i;
  const isBlockedSrc = (value: any): boolean => {
    let url: string;
    try {
      url = String(value);
    } catch {
      return false;
    }
    return blockedClankRe.test(url) || blockedExtensionRe.test(url);
  };
  if (typeof HTMLScriptElement === "function") {
    let proto: any = HTMLScriptElement.prototype;
    let srcDesc: any = proto ? Object.getOwnPropertyDescriptor(proto, "src") : undefined;
    while (!srcDesc && proto) {
      proto = Object.getPrototypeOf(proto);
      if (proto) srcDesc = Object.getOwnPropertyDescriptor(proto, "src");
    }
    if (srcDesc && typeof srcDesc.set === "function") {
      const originalSetSrc = srcDesc.set;
      Object.defineProperty(HTMLScriptElement.prototype, "src", {
        configurable: srcDesc.configurable === true,
        enumerable: srcDesc.enumerable === true,
        get: srcDesc.get,
        set(v: any) {
          if (isBlockedSrc(v)) return;
          originalSetSrc.call(this, v);
        },
      });
    }
  }
  if (typeof Element === "function" && typeof Element.prototype.setAttribute === "function") {
    const originalSetAttribute = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (this: any, name: any, value: any) {
      if (typeof HTMLScriptElement === "function"
        && this instanceof HTMLScriptElement
        && typeof name === "string"
        && name.toLowerCase() === "src"
        && isBlockedSrc(value)) {
        return undefined;
      }
      return originalSetAttribute.call(this, name, value);
    };
  }

  // While the document is still loading, a page assigns its __onGCastApiAvailable callback and then the
  // parser loads cast_sender.js; calling the callback on a timer would run it before the page's scripts
  // (and cast.framework) exist. So until DOMContentLoaded only store the callback, then call whatever is
  // stored at that moment. With Google's loader that is its counter wrapper, which stands in for the
  // second report-in and fires the page's callback once the framework has loaded as well.
  const docIsLoading = (): boolean => typeof document !== "undefined" && document.readyState === "loading";
  let onGCastApiAvailable: any = g.__onGCastApiAvailable;
  const notifiedCallbacks = new WeakSet();
  const notifyGCastApiAvailable = (fn: any): void => {
    if (typeof fn !== "function" || notifiedCallbacks.has(fn)) return;
    notifiedCallbacks.add(fn);
    setTimeout(() => safe(fn, true), 0);
  };
  if (docIsLoading() && typeof document.addEventListener === "function") {
    document.addEventListener("DOMContentLoaded", () => notifyGCastApiAvailable(onGCastApiAvailable));
  } else {
    notifyGCastApiAvailable(onGCastApiAvailable);
  }
  Object.defineProperty(g, "__onGCastApiAvailable", {
    configurable: true,
    enumerable: true,
    get: () => onGCastApiAvailable,
    set: (v: any) => {
      onGCastApiAvailable = v;
      if (typeof v === "function" && !docIsLoading()) notifyGCastApiAvailable(v);
    },
  });

  return true;
}
