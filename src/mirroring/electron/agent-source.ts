/**
 * The capture agent: plain JavaScript that runs in a hidden renderer window the library creates and controls, and
 * the preload that hands it its `MessagePort`. They are strings, not functions, so that a bundler or minifier in the
 * app that uses this package cannot change what runs in the renderer.
 *
 * The agent captures a tab (`chromeMediaSource: "tab"`, with the id from `webContents.getMediaSourceId`) or the
 * desktop (`getDisplayMedia`, answered by the main process's `setDisplayMediaRequestHandler`, with loopback audio
 * where the OS has it), reads the tracks with `MediaStreamTrackProcessor`, and encodes with WebCodecs
 * `VideoEncoder` (VP8 by default) and `AudioEncoder` (Opus, 10 ms frames, 48 kHz stereo). The engine decides which
 * raw frames are encoded (the drop decision of `VideoSender::InsertRawVideoFrame`); the agent only holds a few
 * frames for it. A `VideoFrame` goes straight into the encoder; its pixels are read once per encoded frame, to
 * estimate the frame's complexity (media/cast/encoding/frame_complexity_estimator.cc), which stands in for the
 * quantizer WebCodecs does not report, unless the engine finds the quantizer in the encoded frame (H.264, HEVC, VP8,
 * VP9). The engine also tells the agent the capture size to encode at (`capture-size`): the encoder scales frames to
 * its configured size, and a new size has to last 250 ms before the encoder is rebuilt for it
 * (`resize_debounce_timer_` of media/cast/encoding/media_video_encoder_wrapper.cc).
 *
 * Messages are those of agent-protocol.ts.
 */

/** Sandboxed preload: forwards the port the main process posted to the page's main world. */
export const AGENT_PRELOAD_SOURCE = `
const { ipcRenderer } = require("electron");
ipcRenderer.on("electron-cast-mirroring:port", (event) => {
  window.postMessage("electron-cast-mirroring:port", "*", event.ports);
});
`;

export const AGENT_SOURCE = String.raw`
(() => {
  "use strict";
  const epochNow = () => performance.timeOrigin + performance.now();
  let port = null;
  let stream = null;
  let paused = false;
  // Frozen by the browser side (CastMirroringServiceHost::Pause): the device delivers nothing. Apart from the
  // session's own pause above, which the engine uses while it reconfigures the capture.
  let frozen = false;
  let stopped = false;
  let captureAudioParams = null;
  let audioTimestamp = 0;
  let videoEncoder = null;
  let audioEncoder = null;
  let videoCodec = { codec: "vp8", string: "vp8", hardware: false };
  let videoBitrate = 2000000;
  let audioBitrate = 128000;
  let keyNext = true;
  let videoReader = null;
  let videoEpoch = 0;
  let audioEpoch = 0;
  let audioReader = null;
  let videoInfo = null;
  let encoderSize = null;
  let videoConfig = null;
  const pendingFrames = new Map();     // rtp -> VideoFrame, a few frames the engine may ask to encode
  const captureDurations = new Map();  // rtp -> ms from capture begin to end, for the performance overlay
  const MAX_PENDING = 3;
  const inFlight = [];                 // { rtp, ts, key, startedAt } in encoder order
  let lastFrameClone = null;
  let lastRtp = 0;
  let captureSize = null;              // { width, height } the engine's capture size oracle wants encoded, null for the source size
  let encodeChain = Promise.resolve(); // encodes run one after another: the complexity estimate awaits a pixel copy
  let resizeTarget = null;             // { width, height } the encoder is waiting to be rebuilt for (target_resize_size_)
  let resizeTimer = null;              // resize_debounce_timer_
  const RESIZE_DEBOUNCE_MS = 250;
  let estimating = true;               // false while the engine reads the encoder's quantizer instead (encoder_reports_qp_)
  let lastEncodedTimestamp = null;     // capture clock (us) of the frame encoded before, for GetFrameDuration
  let firstTimestamp = null;
  let lastCapture = null;              // { timestamp (capture clock, us), refMs (epoch ms) } of the newest frame, refresh or not
  const pendingAudio = new Map();      // seq -> AudioData
  const audioInFlight = [];
  let audioSeq = 0;

  const send = (message, transfer) => port.postMessage(message, transfer || []);
  const dropVideo = (rtp) => send({ t: "video-drop", rtp });
  const dropAudio = (seq) => send({ t: "audio-drop", seq });
  // Everything still inside a VideoEncoder that is going away produced no output: tell the engine, which would otherwise
  // count those frames as in the encoder for ever. A lost key frame means the next frame has to be one.
  const abandonInFlight = () => {
    for (const e of inFlight.splice(0)) { if (e.key) keyNext = true; dropVideo(e.rtp); }
  };
  const describe = (error) => (error && error.name ? error.name + ": " : "") + String((error && error.message) || error);
  const fail = (where, error) => send({ t: "error", where, message: describe(error) });

  window.addEventListener("message", (event) => {
    if (event.data !== "electron-cast-mirroring:port" || event.ports.length === 0 || port !== null) return;
    port = event.ports[0];
    port.onmessage = (e) => onCommand(e.data).catch((err) => fail("encoder", err));
    port.start();
    send({ t: "ready" });
  });

  async function onCommand(m) {
    switch (m.t) {
      case "start": return start(m);
      case "set-codec":
        // A new offer made a new encoder: the old one (another codec, or the same one that failed) is dropped and the
        // next frame configures the one the offer chose.
        videoCodec = { codec: m.codec, string: m.codecString || m.codec, hardware: m.hardware === true };
        cancelResize();
        if (videoEncoder) {
          if (videoEncoder.state !== "closed") { try { videoEncoder.close(); } catch {} }
          videoEncoder = null;
          encoderSize = null;
          abandonInFlight();
        }
        return;
      case "set-bitrate":
        videoBitrate = m.bps;
        // Chrome only adjusts the bitrate of the running encoder (media_video_encoder_wrapper.cc ChangeOptions): no new
        // encoder, no forced key frame, and frames already inside it keep their place in the queue.
        if (videoEncoder && videoEncoder.state === "configured" && videoConfig) {
          videoConfig = { ...videoConfig, bitrate: videoBitrate };
          videoEncoder.configure(videoConfig);
        }
        return;
      case "set-audio": audioBitrate = m.bps; return;
      case "key-frame": keyNext = true; return;
      case "pause": paused = true; return;
      case "resume": paused = false; return;
      case "freeze": frozen = true; return;
      case "unfreeze": return unfreeze();
      case "switch": return switchSource(m);
      case "refresh":
        // OpenscreenSessionHost::OnRefreshTimerFired -> RequestRefreshFrame: a static screen produces no capture
        // frames, so the last one is sent again. FrameSinkVideoCaptureDevice::RequestRefreshFrame does nothing while
        // the device is suspended.
        if (!frozen) refreshFrame();
        return;
      case "encode": return (encodeChain = encodeChain.then(() => encodeFrame(m.rtp, m.overlay)));
      case "capture-size": captureSize = { width: m.width, height: m.height }; return;
      case "estimate-complexity": estimating = m.on === true; return;
      case "encode-audio": return encodeAudio(m.seq);
      case "drop-audio": { const d = pendingAudio.get(m.seq); pendingAudio.delete(m.seq); if (d) d.close(); return; }
      // The engine's timer. A timer set from a message event is not nested, so it is not clamped to 4 ms.
      case "wake": setTimeout(() => { if (!stopped) send({ t: "wake", id: m.id }); }, m.ms); return;
      case "stop": return stop();
    }
  }

  // The Chromium capture device takes VideoCaptureParams (requested size, resolution_change_policy). A getUserMedia
  // request reaches the same device with the policy Blink derives from the min and max sizes
  // (SelectResolutionPolicyFromCandidates), so the sizes are chosen to give the policy the session host asked for. The
  // minimums are those of VideoCaptureParams::SuggestConstraints.
  //   fixed_resolution:   min = max, every frame is the requested size, the content letterboxed into it.
  //   fixed_aspect_ratio: min is 180 lines of the same aspect ratio, frames keep the aspect ratio of the maximum
  //                       (sender-side letterboxing: a receiver that cannot scale gets a constant aspect ratio).
  //   any_within_limit:   min is 2x2 (a different aspect ratio), frames follow the source's shape.
  function captureLimits(video) {
    const w = video.width - (video.width % 2), h = video.height - (video.height % 2);
    const base = { maxWidth: w, maxHeight: h, maxFrameRate: video.frameRate };
    const ratio = (a, b) => Math.floor((100 * a) / b);
    if (video.resolutionChangePolicy === "fixed_aspect_ratio" && h > 180) {
      for (let minH = 180; minH <= h; minH += 2) {
        const minW = Math.round((minH * w) / h / 2) * 2;
        if (minW > 0 && minW <= w && ratio(minW, minH) === ratio(w, h)) return { ...base, minWidth: minW, minHeight: minH };
      }
      return { ...base, minWidth: w, minHeight: h };
    }
    if (video.resolutionChangePolicy === "any_within_limit") {
      return { ...base, minWidth: 2, minHeight: ratio(2, 2) === ratio(w, h) ? 4 : 2 };
    }
    return { ...base, minWidth: w, minHeight: h };
  }

  // The maximums in the standard syntax getDisplayMedia takes. It refuses min (and exact) constraints, a TypeError
  // ("min constraints are not supported"), so it cannot express the resolution change policy.
  function displayConstraints(limits) {
    const video = { frameRate: { max: limits.maxFrameRate || 30 } };
    if (limits.maxWidth) {
      video.width = { max: limits.maxWidth };
      video.height = { max: limits.maxHeight };
    }
    return video;
  }

  // The configuration of the encoder the offer chose. A hardware offer needs a hardware encoder (the Cast offer lists
  // H.264 only when one exists, and a software one would be a different quality and CPU cost than the receiver was
  // told): prefer-hardware makes Chromium's VideoEncoder refuse to configure without one.
  //
  // The rest follows Chrome's MediaVideoEncoderWrapper constructor. A constant bitrate (Bitrate::ConstantBitrate): a
  // variable one is unconstrained in blink (peak = 10x target, VideoEncoder::ParseConfigStatic), so the target the
  // bandwidth logic picks would not hold. The frame rate only for a hardware encoder, which needs it for level selection
  // and rate control; software encoders go by the per-frame durations of variable-rate capture. The screen content hint
  // (WebCodecs contentHint "text", which blink maps to ContentHint::Screen) except for software VP9
  // (TODO crbug.com/572902679).
  function encoderConfig(width, height) {
    const config = {
      codec: videoCodec.string,
      width, height,
      bitrate: videoBitrate,
      latencyMode: "realtime",
      bitrateMode: "constant",
      hardwareAcceleration: videoCodec.hardware ? "prefer-hardware" : "prefer-software",
    };
    if (videoCodec.hardware) config.framerate = videoInfo ? videoInfo.frameRate : 30;
    if (videoCodec.codec !== "vp9" || videoCodec.hardware) config.contentHint = "text";
    // Cast Streaming carries Annex B, with the parameter sets in the key frames.
    if (videoCodec.codec === "h264") config.avc = { format: "annexb" };
    if (videoCodec.codec === "hevc") config.hevc = { format: "annexb" };
    return config;
  }

  function refreshFrame() {
    if (!lastFrameClone || !lastCapture) return;
    // Stamped with the time that has passed, on the same capture-clock-to-RTP mapping as real frames, so the
    // receiver's playout clock keeps running.
    const clone = lastFrameClone.clone();
    const nowMs = nextRefMs(epochNow());
    const rtp = rtpFor(lastCapture.timestamp + (nowMs - lastCapture.refMs) * 1000);
    lastCapture = { timestamp: lastCapture.timestamp + (nowMs - lastCapture.refMs) * 1000, refMs: nowMs };
    holdFrame(rtp, clone);
    // refresh: it repeats the last frame, which is no new content to the capture-size oracle.
    send({ t: "frame", rtp, refMs: nowMs, width: clone.displayWidth, height: clone.displayHeight, refresh: true });
  }

  function trackStates(tracks) {
    return tracks.length === 0 ? "none" : tracks.map((t) => t.readyState ?? "?").join(" ");
  }

  // ResumeDevice restarts the capturer (FrameSinkVideoCaptureDevice::MaybeStartConsuming), and a restarted capturer
  // delivers a frame at once even when nothing on screen has changed: here the last one.
  function unfreeze() {
    if (!frozen) return;
    frozen = false;
    refreshFrame();
  }

  // getDisplayMedia would need transient user activation, which this hidden page never has (NotAllowedError, shown
  // as "Permission denied"). Chrome's own mirroring service does not ask either: CastMirroringServiceHost hands the
  // desktop media id straight to the capture host and opens the system loopback device for audio
  // (CreateAudioStreamForDesktop). The legacy constraints are the renderer-side equivalent: the source id the app
  // chose, and chromeMediaSource "desktop" (no id) for loopback audio. Used by start and by a tab switch; a refusal
  // is thrown with the track that caused it.
  async function openStream(source, video, audio) {
    const tab = source.kind === "tab";
    const sourceKind = tab ? "tab" : "desktop";
    const idConstraint = tab ? { chromeMediaSourceId: source.mediaSourceId } : { chromeMediaSourceId: source.sourceId };
    const limits = video ? captureLimits(video) : {};
    const videoWanted = !!video || !tab;
    const acquire = (withAudio, withVideo) => navigator.mediaDevices.getUserMedia({
      audio: withAudio ? { mandatory: tab ? { chromeMediaSource: "tab", ...idConstraint } : { chromeMediaSource: "desktop" } } : false,
      video: withVideo ? { mandatory: { chromeMediaSource: sourceKind, ...idConstraint, ...limits } } : false,
    });
    try {
      if (!tab && audio && source.audio === "loopbackWithMute") {
        // Only getDisplayMedia reaches 'loopbackWithMute' (the host's handler on this window's own session answers with
        // the app's source and it). Its video track is dropped: getDisplayMedia takes no minimum size, so its capture
        // would always be any_within_limit (SelectResolutionPolicyFromCandidates' default for a screen), where Chrome
        // captures the screen with the session's policy. The video comes from the same request as without audio.
        const display = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: displayConstraints(limits) });
        for (const t of display.getVideoTracks()) t.stop();
        const audioTracks = display.getAudioTracks();
        send({ t: "log", message: "capture: system audio from getDisplayMedia, " + trackStates(audioTracks) });
        let videoTracks = [];
        try { videoTracks = (await acquire(false, true)).getVideoTracks(); }
        catch (err) { for (const t of audioTracks) t.stop(); throw err; }
        const all = [...audioTracks, ...videoTracks];
        return { getAudioTracks: () => audioTracks, getVideoTracks: () => videoTracks, getTracks: () => all };
      }
      return await acquire(!!audio, videoWanted);
    } catch (err) {
      // One call serves both tracks, so say which one the browser refused: try the video alone.
      let which = video ? "video" : "audio";
      if (audio && videoWanted) {
        try { (await acquire(false, true)).getTracks().forEach((t) => t.stop()); which = "audio"; } catch { which = "video"; }
      }
      throw { which, err };
    }
  }

  // OpenscreenSessionHost::SwitchSourceTab: the video capture client gets the new tab's capture host and restarts with
  // the same parameters, and the audio input device is stopped and started. Encoders, frame ids and timelines belong to
  // the session and carry on; a new capturer is not suspended (DidGetTabSourceId sets PLAYING).
  async function switchSource(m) {
    if (!stream || stopped) return;
    const video = m.video ? videoInfo : null;
    const audio = m.audio ? captureAudioParams : null;
    let next;
    try { next = await openStream(m.source, video, audio); }
    catch (e) { fail(e.which, e.err); return; }
    if (stopped) { for (const t of next.getTracks()) t.stop(); return; }
    for (const t of stream.getTracks()) t.stop();
    stream = next;
    frozen = false;
    // The old page's last frame is not a refresh of the new page's.
    if (lastFrameClone) { lastFrameClone.close(); lastFrameClone = null; }
    lastCapture = null;
    firstTimestamp = null;
    // The new track's timestamps may count from another origin, so its offset to the epoch clock is learnt again.
    offsetMs = null;
    // The new tab's capture starts at its own size until the engine's new oracle says otherwise.
    captureSize = null;
    const nextVideo = next.getVideoTracks()[0];
    const nextAudio = next.getAudioTracks()[0];
    if (video && nextVideo) pumpVideo(nextVideo, video);
    else if (video) fail("video", "the capture has no video track");
    if (audio && nextAudio) pumpAudio(nextAudio, audio);
    else if (audio) fail("audio", "the capture has no audio track");
  }

  async function start(m) {
    captureAudioParams = m.audio || null;
    try {
      stream = await openStream(m.source, m.video, m.audio);
    } catch (e) {
      fail(e.which, e.err);
      return;
    }
    const video = stream.getVideoTracks()[0];
    const audio = stream.getAudioTracks()[0];
    // Electron's capturer can hand over a track that is already ended (macOS system audio without the System Audio
    // Recording permission) and say nothing, so the states are logged.
    send({ t: "log", message: "capture: started, video " + trackStates(stream.getVideoTracks()) + ", audio " + trackStates(stream.getAudioTracks()) });
    if (m.source.kind === "desktop" && video && !m.video) video.stop();
    if (m.video && video) pumpVideo(video, m.video);
    else if (m.video) fail("video", "the capture has no video track");
    if (m.audio && audio) pumpAudio(audio, m.audio);
    else if (m.audio) fail("audio", "the capture has no audio track");
  }

  // Presentation time in RTP ticks (90 kHz) from the capture clock, made strictly increasing.
  // A new capture (a switched tab) has its own clock: its first frame continues 1 ms after the last one sent, as
  // VideoCaptureClient does (accumulated_time_ = last_timestamp_ + 1 ms).
  let baseRtp = 90000;
  function rtpFor(timestamp) {
    if (firstTimestamp === null) {
      firstTimestamp = timestamp;
      baseRtp = lastRtp === 0 ? 90000 : lastRtp + 90;
    }
    let rtp = Math.round(((timestamp - firstTimestamp) * 90) / 1000) + baseRtp;
    if (rtp <= lastRtp) rtp = lastRtp + 1;
    lastRtp = rtp;
    return rtp;
  }

  function holdFrame(rtp, frame) {
    pendingFrames.set(rtp, frame);
    while (pendingFrames.size > MAX_PENDING) {
      const oldest = pendingFrames.keys().next().value;
      pendingFrames.get(oldest).close();
      pendingFrames.delete(oldest);
      captureDurations.delete(oldest);
    }
  }

  // FrameComplexityEstimator (media/cast/encoding/frame_complexity_estimator.cc), a port of Chrome's: the entropy of the
  // luma differences, between neighbouring pixels for a key frame and against the same pixel of the last frame
  // otherwise, over 10% of the rows, mapped linearly to [0, 1]. WebCodecs reports no quantizer, which is the case
  // MediaVideoEncoderWrapper falls back to this estimate for.
  const SAMPLING_PERCENT = 10;
  const HISTOGRAM_SIZE = 511;
  const ENTROPY_AT_MAX_COMPLEXITY = 7.5;
  const complexity = { last: new Uint8Array(0), width: 0, height: 0, copy: new Uint8Array(0) };
  const examinable = (f) => /^(I420|I420A|I422|I444|NV12)$/.test(f.format) && f.visibleRect && f.visibleRect.width > 0 && f.visibleRect.height > 0;
  function entropyOf(histogram, samples) {
    let entropy = 0;
    for (let i = 0; i < histogram.length; i++) {
      const p = histogram[i] / samples;
      if (p > 0) entropy -= p * Math.log2(p);
    }
    return Math.min(1, entropy / ENTROPY_AT_MAX_COMPLEXITY);
  }
  function estimateFromLuma(luma, stride, width, height, key) {
    const rows = Math.max(1, Math.floor((height * SAMPLING_PERCENT) / 100));
    const rowSkip = Math.floor(height / rows);
    // A new frame size has nothing to compare with: it is estimated as a key frame.
    if (!key && (complexity.width !== width || complexity.height !== height || complexity.last.length === 0)) key = true;
    if (complexity.width !== width || complexity.height !== height || complexity.last.length === 0) {
      complexity.last = new Uint8Array(width * rows);
      complexity.width = width;
      complexity.height = height;
    }
    const histogram = new Int32Array(HISTOGRAM_SIZE);
    let y = 0;
    for (let i = 0; i < rows; i++, y += rowSkip) {
      const row = luma.subarray(y * stride, y * stride + width);
      const kept = complexity.last.subarray(i * width, (i + 1) * width);
      if (key) {
        for (let x = 1; x < width; x++) histogram[row[x] - row[x - 1] + 255]++;
      } else {
        for (let x = 0; x < width; x++) histogram[row[x] - kept[x] + 255]++;
      }
      kept.set(row);
    }
    const samples = key ? (width - 1) * rows : width * rows;
    return samples > 0 ? entropyOf(histogram, samples) : null;
  }
  async function estimateComplexity(frame, key) {
    try {
      if (!examinable(frame)) return null;
      const need = frame.allocationSize();
      if (complexity.copy.length < need) complexity.copy = new Uint8Array(need);
      const layout = await frame.copyTo(complexity.copy);
      const { offset, stride } = layout[0];
      return estimateFromLuma(complexity.copy.subarray(offset), stride, frame.visibleRect.width, frame.visibleRect.height, key);
    } catch {
      return null;
    }
  }

  async function pumpVideo(track, params) {
    videoInfo = params;
    // A switch starts another pump on the new track; this one ends with its own track.
    const epoch = ++videoEpoch;
    const reader = videoReader = new MediaStreamTrackProcessor({ track }).readable.getReader();
    // Chrome's SmoothEventSampler (media/capture/content/smooth_event_sampler.cc): a token bucket that fills with the time
    // between frames, holds at most 1.5 periods and pays one period per frame kept. A 60 Hz source thins to the target rate,
    // and a burst after a gap (two frames 17 ms apart, then 90 ms of nothing) is kept whole instead of being cut in half.
    const period = 1000 / params.frameRate;
    const bucketCapacity = period * 1.5;
    let tokens = bucketCapacity;
    let lastEventMs = null;
    let lastAcceptedAt = -1e9;
    captureStats.since = 0;
    for (;;) {
      const { value: frame, done } = await reader.read();
      if (done || stopped || epoch !== videoEpoch) { if (frame) frame.close(); return; }
      if (paused || frozen) { frame.close(); continue; }
      // The capture may deliver faster than the requested rate (a 60 Hz page); keep the minimum frame interval.
      // It is judged on the capture timestamps: frames that arrive bunched after a stall still carry their regular capture
      // times, and dropping them on arrival time would turn a 30 fps capture into an irregular ~25 fps one.
      const arrivalMs = epochNow();
      const captureMs = frame.timestamp / 1000;
      captureStats.received++;
      if (captureStats.lastArrival > 0) captureStats.arrivalGaps.push(arrivalMs - captureStats.lastArrival);
      captureStats.lastArrival = arrivalMs;
      if (lastEventMs !== null && lastEventMs < captureMs) tokens = Math.min(bucketCapacity, tokens + (captureMs - lastEventMs));
      lastEventMs = captureMs;
      // The small allowance is for timestamps that are rounded to microseconds.
      if (tokens < period - 0.01) { captureStats.limited++; frame.close(); continue; }
      tokens = Math.max(0, tokens - period);
      if (lastAcceptedAt > -1e8) captureStats.intervals.push(captureMs - lastAcceptedAt);
      captureStats.arrivalLag.push(arrivalMs - (captureTimeOf(frame, captureMs, arrivalMs)));
      lastAcceptedAt = captureMs;
      reportCaptureStats(arrivalMs);
      const rtp = rtpFor(frame.timestamp);
      // The reference time is the capture time on the epoch clock, not the arrival time: the receiver pairs it with the
      // RTP timestamp in the sender reports, and a jittery arrival would skew that pairing (Chrome stamps frames with
      // the capture begin time, VideoFrameMetadata REFERENCE_TIME).
      // Chrome's frame metadata carries the true capture time (performance.now timeline) when the source has one; the
      // smallest delay seen stands in when it does not.
      let exact = NaN;
      try { const md = frame.metadata ? frame.metadata() : null; if (md && typeof md.captureTime === "number") exact = performance.timeOrigin + md.captureTime; } catch { /* no metadata */ }
      const refMs = nextRefMs(Number.isFinite(exact) ? exact : captureMs + captureOffsetMs(captureMs, arrivalMs));
      lastCapture = { timestamp: frame.timestamp, refMs };
      if (lastFrameClone) lastFrameClone.close();
      lastFrameClone = frame.clone();
      holdFrame(rtp, frame);
      captureDurations.set(rtp, Math.max(refMs, arrivalMs) - refMs);
      send({ t: "frame", rtp, refMs, width: frame.displayWidth, height: frame.displayHeight, captureBeginMs: refMs, captureEndMs: Math.max(refMs, arrivalMs) });
    }
  }

  // The capture clock's offset to the epoch clock: the smallest delay seen is the frame that travelled fastest, so it is
  // the best estimate of the true offset, and it may creep up (0.01 ms per frame) to follow clock drift.
  // The sender ignores a frame whose reference time does not advance, so a refresh frame stamped with "now" must not
  // overtake the capture time of the real frame that follows it.
  let lastRefMs = 0;
  function nextRefMs(ms) {
    lastRefMs = ms > lastRefMs ? ms : lastRefMs + 0.001;
    return lastRefMs;
  }
  function captureTimeOf(frame, captureMs, arrivalMs) {
    try { const md = frame.metadata ? frame.metadata() : null; if (md && typeof md.captureTime === "number") return performance.timeOrigin + md.captureTime; } catch { /* no metadata */ }
    return captureMs + captureOffsetMs(captureMs, arrivalMs);
  }
  let offsetMs = null;
  function captureOffsetMs(captureMs, arrivalMs) {
    const sample = arrivalMs - captureMs;
    offsetMs = offsetMs === null ? sample : Math.min(sample, offsetMs + 0.01);
    return offsetMs;
  }

  // Debug aid, not in Chrome: how steady the capture is, once every five seconds.
  const captureStats = { received: 0, limited: 0, intervals: [], arrivalLag: [], arrivalGaps: [], lastArrival: 0, since: 0 };
  function reportCaptureStats(nowMs) {
    if (captureStats.since === 0) captureStats.since = nowMs;
    if (nowMs - captureStats.since < 5000) return;
    const iv = captureStats.intervals.slice().sort((a, b) => a - b);
    const lag = captureStats.arrivalLag.slice().sort((a, b) => a - b);
    const gaps = captureStats.arrivalGaps.slice().sort((a, b) => a - b);
    const at = (a, q) => (a.length ? Math.round(a[Math.min(a.length - 1, Math.floor(a.length * q))] * 10) / 10 : 0);
    const seconds = (nowMs - captureStats.since) / 1000;
    send({ t: "log", message: "capture: " + Math.round((captureStats.received / seconds) * 10) / 10 + " fps delivered, " + Math.round((iv.length / seconds) * 10) / 10 + " fps kept, " + captureStats.limited + " dropped by the rate limit; capture interval p50 " + at(iv, 0.5) + " ms, p95 " + at(iv, 0.95) + " ms, max " + at(iv, 1) + " ms; arrival gap p5 " + at(gaps, 0.05) + " ms, p50 " + at(gaps, 0.5) + " ms, p95 " + at(gaps, 0.95) + " ms, max " + at(gaps, 1) + " ms; delivery delay p50 " + at(lag, 0.5) + " ms, p95 " + at(lag, 0.95) + " ms, max " + at(lag, 1) + " ms" });
    captureStats.received = 0; captureStats.limited = 0; captureStats.intervals = []; captureStats.arrivalLag = []; captureStats.arrivalGaps = []; captureStats.since = nowMs;
  }

  function configureVideo(width, height) {
    if (videoEncoder && videoEncoder.state !== "closed") videoEncoder.close();
    abandonInFlight();
    encoderSize = { width, height };
    // ConstructEncoder: nothing is known about a new encoder's quantizer (encoder_reports_qp_ = false).
    estimating = true;
    videoEncoder = new VideoEncoder({
      output: (chunk) => {
        // A software VP8 encoder may swallow a frame without output. The chunk's timestamp is the frame's, so frames
        // queued ahead of the matching one were dropped inside the encoder.
        let i = inFlight.findIndex((e) => e.ts === chunk.timestamp);
        if (i < 0) i = 0;
        for (const gone of inFlight.splice(0, i)) { if (gone.key) keyNext = true; dropVideo(gone.rtp); }
        const info = inFlight.shift();
        if (!info) return;
        const data = new ArrayBuffer(chunk.byteLength);
        chunk.copyTo(data);
        const message = { t: "video-chunk", rtp: info.rtp, key: chunk.type === "key", data, encodeMs: performance.now() - info.startedAt, durationMs: info.durationMs };
        if (info.complexity !== null) message.complexity = info.complexity;
        send(message);
      },
      error: (err) => { abandonInFlight(); send({ t: "encoder-status", kind: "video", status: "codec_runtime_error", message: describe(err) }); },
    });
    videoConfig = encoderConfig(width, height);
    videoEncoder.configure(videoConfig);
    keyNext = true;
  }

  function cancelResize() {
    if (resizeTimer !== null) clearTimeout(resizeTimer);
    resizeTimer = null;
    resizeTarget = null;
  }

  // MediaVideoEncoderWrapper::EncodeVideoFrame, for a frame of another size than the encoder's: the encoder is rebuilt
  // only once a size has lasted 250 ms, so a size that keeps changing (a window being dragged, the capture size oracle
  // stepping) does not cost an encoder and a key frame per step. The wait starts over only for a size other than the
  // one already waited for. Frames are not held back meanwhile: the running encoder takes them and scales them to the
  // size it has.
  function debounceResize(width, height) {
    if (resizeTarget && resizeTarget.width === width && resizeTarget.height === height) return;
    if (resizeTimer !== null) clearTimeout(resizeTimer);
    resizeTarget = { width, height };
    // The timer fires whether or not frames arrive, as Chrome's does. Its work takes its turn among the encodes; a
    // frame that cancels or restarts the wait before that turn comes wins.
    const timer = resizeTimer = setTimeout(() => {
      encodeChain = encodeChain.then(() => (resizeTimer === timer ? reconstructEncoderForNewSize(width, height) : undefined));
    }, RESIZE_DEBOUNCE_MS);
  }

  // MediaVideoEncoderWrapper::ReconstructEncoderForNewSize. ConstructEncoder reports the frames still in the old
  // encoder as dropped, and the new encoder's first frame is a key frame.
  async function reconstructEncoderForNewSize(width, height) {
    resizeTimer = null;
    resizeTarget = null;
    if (stopped || !videoEncoder || !encoderSize || (encoderSize.width === width && encoderSize.height === height)) return;
    try {
      const support = await VideoEncoder.isConfigSupported(encoderConfig(width, height));
      if (!support.supported) { send({ t: "encoder-status", kind: "video", status: "unsupported_codec", message: videoCodec.string + (videoCodec.hardware ? " (hardware)" : "") + " at " + width + "x" + height }); return; }
      configureVideo(width, height);
    } catch (err) {
      send({ t: "encoder-status", kind: "video", status: "codec_init_failed", message: describe(err) });
    }
  }

  // The size to encode a frame at: the oracle's capture size while it keeps the frame's aspect ratio and is not larger,
  // else the frame's own (a source that changed shape is followed at once; the oracle catches up).
  function encodeSize(frame) {
    const w = frame.displayWidth, h = frame.displayHeight;
    const t = captureSize;
    if (!t || t.width >= w || t.height >= h) return { width: w, height: h };
    if (Math.abs(t.width * h - t.height * w) > 0.02 * t.height * w) return { width: w, height: h };
    return t;
  }

  // RenderPerformanceMetricsOverlay (media/cast/sender/performance_metrics_overlay.cc), drawn on a copy of the frame
  // just before it is encoded (VideoSender::InsertRawVideoFrame, kCastStreamingPerformanceOverlay). Each glyph is a few
  // rectangles of a 3x5 grid, 4 pixels per grid cell, and "diverges" the luma of its pixels by 48 so it shows on any
  // background. Only 8-bit planar I420 and NV12 are drawn on, as in Chrome, which returns other frames untouched.
  // The layout is that of current Chromium main, which moves the pointer on before each glyph
  // (p_ul = p_ul.subspan(kPixelsPerChar) at the top of the loop in RenderLineOfText). Chrome 120 moved it on after the
  // glyph (for (size_t i = first_idx; i < line.size(); ++i, p_ul += kPixelsPerChar)), which right-aligns the line; main's
  // shifts every glyph one cell to the right, so the last one runs past the visible width into the start of the next row
  // of pixels. That looks like a regression from the span refactor, not a design, and may be fixed upstream; it is
  // reproduced because the rule is to match current Chrome.
  const OVERLAY_SCALE = 4, OVERLAY_GLYPH_W = 3, OVERLAY_SPACING = 1, OVERLAY_LINE_HEIGHT = (5 + 2) * OVERLAY_SCALE;
  const OVERLAY_PX_PER_CHAR = (OVERLAY_GLYPH_W + OVERLAY_SPACING) * OVERLAY_SCALE;
  const GLYPHS = {
    "!": [[1,0,1,3],[1,4,1,1]], "%": [[0,0,1,1],[2,1,1,1],[1,2,1,1],[0,3,1,1],[2,4,1,1]],
    "+": [[1,1,1,1],[1,3,1,1],[0,2,3,1]], "-": [[0,2,3,1]], ".": [[1,4,1,1]],
    "0": [[0,0,3,1],[0,1,1,3],[2,1,1,3],[0,4,3,1]], "1": [[1,0,1,5]],
    "2": [[0,0,3,1],[2,1,1,1],[0,2,3,1],[0,3,1,1],[0,4,3,1]], "3": [[0,0,3,1],[2,1,1,1],[0,2,3,1],[2,3,1,1],[0,4,3,1]],
    "4": [[0,0,1,2],[2,0,1,5],[0,2,2,1]], "5": [[0,0,3,1],[0,1,1,1],[0,2,3,1],[2,3,1,1],[0,4,3,1]],
    "6": [[1,0,2,1],[0,1,1,1],[0,2,3,1],[0,3,1,1],[2,3,1,1],[0,4,3,1]], "7": [[0,0,3,1],[2,1,1,2],[1,3,1,2]],
    "8": [[0,0,3,1],[0,1,1,1],[2,1,1,1],[0,2,3,1],[0,3,1,1],[2,3,1,1],[0,4,3,1]],
    "9": [[0,0,3,1],[0,1,1,1],[2,1,1,1],[0,2,3,1],[2,3,1,1],[0,4,2,1]],
    ":": [[1,1,1,1],[1,3,1,1]], "e": [[0,0,3,1],[0,1,1,1],[0,2,2,1],[0,3,1,1],[0,4,3,1]],
    "x": [[0,1,1,1],[2,1,1,1],[1,2,1,1],[0,3,1,1],[2,3,1,1]],
  };
  // printf("%<width>.1d"): the integer padded with spaces to the width.
  const padInt = (n, width) => String(n).padStart(width, " ");
  const saturatedInt = (x) => Math.max(-2147483648, Math.min(2147483647, Math.trunc(x)));
  function drawOverlayLine(luma, offset, stride, width, line, top) {
    const lineWidth = ((OVERLAY_GLYPH_W + OVERLAY_SPACING) * line.length + OVERLAY_SPACING) * OVERLAY_SCALE;
    const first = lineWidth < width ? 0 : Math.floor((lineWidth - width) / OVERLAY_PX_PER_CHAR) + 1;
    let x0 = width - lineWidth + first * OVERLAY_PX_PER_CHAR;
    for (let i = first; i < line.length; i++) {
      x0 += OVERLAY_PX_PER_CHAR;
      const rects = GLYPHS[line[i].toLowerCase()];
      if (!rects) continue;
      for (const [rx, ry, rw, rh] of rects) {
        for (let y = ry * OVERLAY_SCALE; y < (ry + rh) * OVERLAY_SCALE; y++) {
          for (let x = rx * OVERLAY_SCALE; x < (rx + rw) * OVERLAY_SCALE; x++) {
            const at = offset + (top + y) * stride + x0 + x;
            if (at < 0 || at >= luma.length) continue;
            const v = luma[at];
            // [16,63] -> [64,111]; [64,235] -> [16,187]
            luma[at] = v >= 64 ? v - 48 : v + 48;
          }
        }
      }
    }
  }
  async function overlaid(frame, overlay, captureMs) {
    try {
      if (frame.format !== "I420" && frame.format !== "NV12") return frame;
      const rect = frame.visibleRect;
      let top = rect.height - OVERLAY_LINE_HEIGHT;
      if (top < 0) return frame;
      const buffer = new Uint8Array(frame.allocationSize());
      const layout = await frame.copyTo(buffer);
      const { offset, stride } = layout[0];
      // Line 3: frame duration, size and timestamp
      const decimillis = saturatedInt((frame.duration ? frame.duration : 0) / 100 + 0.5);
      let rem = frame.timestamp;
      const minutes = Math.floor(rem / 60000000); rem -= minutes * 60000000;
      const seconds = Math.floor(rem / 1000000); rem -= seconds * 1000000;
      const hundredths = Math.floor(Math.floor(rem / 1000) / 10);
      drawOverlayLine(buffer, offset, stride, rect.width,
        Math.floor(decimillis / 10) + "." + (decimillis % 10) + " " + rect.width + "x" + rect.height + " " + minutes + ":" + String(seconds).padStart(2, "0") + "." + String(hundredths).padStart(2, "0"), top);
      top -= OVERLAY_LINE_HEIGHT;
      if (top >= 0) {
        // Line 2: capture duration, target playout delay, low latency mode, target bitrate
        const delay = saturatedInt(overlay.targetPlayoutDelayMs + 0.5);
        drawOverlayLine(buffer, offset, stride, rect.width,
          saturatedInt(captureMs + 0.5) + " " + padInt(delay, 4) + (overlay.lowLatencyMode ? "!" : ".") + " " + padInt(Math.trunc(overlay.targetBitrate / 1000), 4), top);
        top -= OVERLAY_LINE_HEIGHT;
      }
      if (top >= 0) {
        // Line 1: frames in the encoder, encoder utilization, lossiness
        drawOverlayLine(buffer, offset, stride, rect.width,
          overlay.framesAgo + " " + padInt(saturatedInt(overlay.encoderUtilization * 100 + 0.5), 3) + "% " + padInt(saturatedInt(overlay.lossiness * 100 + 0.5), 3) + "%", top);
      }
      return new VideoFrame(buffer, {
        format: frame.format, codedWidth: rect.width, codedHeight: rect.height, timestamp: frame.timestamp,
        duration: frame.duration == null ? undefined : frame.duration, layout,
        displayWidth: frame.displayWidth, displayHeight: frame.displayHeight, colorSpace: frame.colorSpace,
      });
    } catch {
      // "Cannot render overlay": the source frame goes on.
      return frame;
    }
  }

  async function encodeFrame(rtp, overlay) {
    let frame = pendingFrames.get(rtp);
    if (!frame) { dropVideo(rtp); return; }
    pendingFrames.delete(rtp);
    const captureMs = captureDurations.get(rtp) || 0;
    captureDurations.delete(rtp);
    try {
      if (overlay) {
        const drawn = await overlaid(frame, overlay, captureMs);
        if (drawn !== frame) { frame.close(); frame = drawn; }
      }
      const { width: w, height: h } = encodeSize(frame);
      if (!videoEncoder || videoEncoder.state === "closed" || !encoderSize) {
        // EncodeVideoFrame: the first frame makes the encoder at once, to avoid startup latency.
        cancelResize();
        const support = await VideoEncoder.isConfigSupported(encoderConfig(w, h));
        if (!support.supported) { dropVideo(rtp); send({ t: "encoder-status", kind: "video", status: "unsupported_codec", message: videoCodec.string + (videoCodec.hardware ? " (hardware)" : "") + " at " + w + "x" + h }); return; }
        configureVideo(w, h);
      } else if (encoderSize.width !== w || encoderSize.height !== h) {
        debounceResize(w, h);
      } else if (resizeTimer !== null) {
        // The size came back to the encoder's before the wait was over: no resize.
        cancelResize();
      }
      // A queue that grows means the encoder cannot keep up: skip, the engine sees the missing chunk as a drop.
      if (videoEncoder.encodeQueueSize > 4) { dropVideo(rtp); return; }
      const key = keyNext;
      keyNext = false;
      // EncodeVideoFrame: no estimate while the encoder's own quantizer is known.
      const estimated = estimating ? await estimateComplexity(frame, key) : null;
      // GetFrameDuration: the frame's own duration, else the time since the last frame within [1/60 s, 1/24 s].
      const durationMs = frame.duration != null && frame.duration > 0
        ? frame.duration / 1000
        : Math.min(Math.max((frame.timestamp - (lastEncodedTimestamp === null ? 0 : lastEncodedTimestamp)) / 1000, 1000 / 60), 1000 / 24);
      lastEncodedTimestamp = frame.timestamp;
      inFlight.push({ rtp, ts: frame.timestamp, key, startedAt: performance.now(), complexity: estimated, durationMs });
      videoEncoder.encode(frame, { keyFrame: key });
    } catch (err) {
      dropVideo(rtp);
      send({ t: "encoder-status", kind: "video", status: "codec_init_failed", message: describe(err) });
    } finally {
      frame.close();
    }
  }

  async function pumpAudio(track, params) {
    const epoch = ++audioEpoch;
    const reader = audioReader = new MediaStreamTrackProcessor({ track }).readable.getReader();
    const channels = params.channels, rate = params.sampleRate, block = rate / 100;
    const planes = [];
    for (let c = 0; c < channels; c++) planes.push(new Float32Array(0));
    // A switched tab keeps the session's audio encoder: its frames and timeline go on.
    if (!audioEncoder || audioEncoder.state === "closed") {
    audioEncoder = new AudioEncoder({
      output: (chunk) => {
        const seq = audioInFlight.shift();
        if (seq === undefined) return;
        const data = new ArrayBuffer(chunk.byteLength);
        chunk.copyTo(data);
        send({ t: "audio-chunk", seq, data });
      },
      error: (err) => { for (const q of audioInFlight.splice(0)) dropAudio(q); send({ t: "encoder-status", kind: "audio", status: "codec_runtime_error" }); fail("encoder", err); },
    });
    try {
      const support = await AudioEncoder.isConfigSupported({ codec: "opus", sampleRate: rate, numberOfChannels: channels, bitrate: audioBitrate });
      if (!support.supported) { send({ t: "encoder-status", kind: "audio", status: "unsupported_codec" }); return; }
      audioEncoder.configure({ codec: "opus", sampleRate: rate, numberOfChannels: channels, bitrate: audioBitrate, opus: { frameDuration: 10000, application: "lowdelay" } });
    } catch (err) { fail("encoder", err); return; }
    }
    let audioClock = null;               // epoch ms of the first sample of the next 10 ms buffer
    for (;;) {
      const { value: data, done } = await reader.read();
      if (done || stopped || epoch !== audioEpoch) { if (data) data.close(); return; }
      // The time of the oldest sample we hold. A capture gap (underrun) moves the clock forward, a burst (overrun) does
      // not move it back, so buffer times keep increasing by 10 ms; the engine's EncodeAudio port resolves gaps.
      const startOfHeld = epochNow() - (data.numberOfFrames + planes[0].length) * 1000 / rate;
      if (audioClock === null || startOfHeld > audioClock) audioClock = startOfHeld;
      // Re-block into 10 ms buffers: the sender counts and encodes audio in those.
      for (let c = 0; c < channels; c++) {
        const add = new Float32Array(data.numberOfFrames);
        data.copyTo(add, { planeIndex: Math.min(c, data.numberOfChannels - 1), format: "f32-planar" });
        const merged = new Float32Array(planes[c].length + add.length);
        merged.set(planes[c]); merged.set(add, planes[c].length);
        planes[c] = merged;
      }
      data.close();
      while (planes[0].length >= block) {
        const buffer = new Float32Array(block * channels);
        for (let c = 0; c < channels; c++) { buffer.set(planes[c].subarray(0, block), c * block); planes[c] = planes[c].slice(block); }
        const seq = audioSeq++;
        pendingAudio.set(seq, new AudioData({ format: "f32-planar", sampleRate: rate, numberOfFrames: block, numberOfChannels: channels, timestamp: audioTimestamp, data: buffer }));
        audioTimestamp += 10000;
        send({ t: "audio-buffer", seq, frames: block, recMs: audioClock });
        audioClock += 10;
        if (pendingAudio.size > 50) { const first = pendingAudio.keys().next().value; pendingAudio.get(first).close(); pendingAudio.delete(first); dropAudio(first); }
      }
    }
  }

  function encodeAudio(seq) {
    const data = pendingAudio.get(seq);
    if (!data) { dropAudio(seq); return; }
    pendingAudio.delete(seq);
    try { audioInFlight.push(seq); audioEncoder.encode(data); }
    catch (err) { audioInFlight.pop(); dropAudio(seq); fail("encoder", err); }
    finally { data.close(); }
  }

  function stop() {
    stopped = true;
    cancelResize();
    if (stream) for (const t of stream.getTracks()) t.stop();
    for (const f of pendingFrames.values()) f.close();
    pendingFrames.clear();
    for (const d of pendingAudio.values()) d.close();
    pendingAudio.clear();
    if (lastFrameClone) lastFrameClone.close();
    try { if (videoEncoder && videoEncoder.state !== "closed") videoEncoder.close(); } catch {}
    try { if (audioEncoder && audioEncoder.state !== "closed") audioEncoder.close(); } catch {}
    if (port) port.close();
  }
})();
`;
