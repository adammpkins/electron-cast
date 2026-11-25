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
 * frames for it and never copies pixels: a `VideoFrame` goes straight into the encoder.
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
  let stopped = false;
  let videoEncoder = null;
  let audioEncoder = null;
  let videoCodec = { codec: "vp8", string: "vp8" };
  let videoBitrate = 2000000;
  let audioBitrate = 128000;
  let keyNext = true;
  let videoReader = null;
  let audioReader = null;
  let videoInfo = null;
  let encoderSize = null;
  let videoConfig = null;
  const pendingFrames = new Map();     // rtp -> VideoFrame, a few frames the engine may ask to encode
  const MAX_PENDING = 3;
  const inFlight = [];                 // { rtp, ts, key, startedAt } in encoder order
  let lastFrameClone = null;
  let lastRtp = 0;
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
      case "set-codec": videoCodec = { codec: m.codec, string: m.codecString || m.codec }; return;
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
      case "refresh":
        // OpenscreenSessionHost::OnRefreshTimerFired -> RequestRefreshFrame: a static screen produces no capture
        // frames, so the last one is sent again. It is stamped with the time that has passed, on the same
        // capture-clock-to-RTP mapping as real frames, so the receiver's playout clock keeps running.
        if (lastFrameClone && lastCapture) {
          const clone = lastFrameClone.clone();
          const nowMs = nextRefMs(epochNow());
          const rtp = rtpFor(lastCapture.timestamp + (nowMs - lastCapture.refMs) * 1000);
          lastCapture = { timestamp: lastCapture.timestamp + (nowMs - lastCapture.refMs) * 1000, refMs: nowMs };
          holdFrame(rtp, clone);
          send({ t: "frame", rtp, refMs: nowMs, width: clone.displayWidth, height: clone.displayHeight });
        }
        return;
      case "encode": return encodeFrame(m.rtp);
      case "encode-audio": return encodeAudio(m.seq);
      case "drop-audio": { const d = pendingAudio.get(m.seq); pendingAudio.delete(m.seq); if (d) d.close(); return; }
      case "stop": return stop();
    }
  }

  async function start(m) {
    // getDisplayMedia would need transient user activation, which this hidden page never has (NotAllowedError, shown
    // as "Permission denied"). Chrome's own mirroring service does not ask either: CastMirroringServiceHost hands the
    // desktop media id straight to the capture host and opens the system loopback device for audio
    // (CreateAudioStreamForDesktop). The legacy constraints are the renderer-side equivalent: the source id the app
    // chose, and chromeMediaSource "desktop" (no id) for loopback audio.
    const tab = m.source.kind === "tab";
    const sourceKind = tab ? "tab" : "desktop";
    const idConstraint = tab ? { chromeMediaSourceId: m.source.mediaSourceId } : { chromeMediaSourceId: m.source.sourceId };
    const limits = m.video ? { maxWidth: m.video.width, maxHeight: m.video.height, maxFrameRate: m.video.frameRate } : {};
    const videoWanted = !!m.video || !tab;
    const acquire = (withAudio, withVideo) => navigator.mediaDevices.getUserMedia({
      audio: withAudio ? { mandatory: tab ? { chromeMediaSource: "tab", ...idConstraint } : { chromeMediaSource: "desktop" } } : false,
      video: withVideo ? { mandatory: { chromeMediaSource: sourceKind, ...idConstraint, ...limits } } : false,
    });
    try {
      stream = !tab && m.audio && m.source.audio === "loopbackWithMute"
        // The host's handler on this window's own session answers with the app's source and 'loopbackWithMute'.
        ? await navigator.mediaDevices.getDisplayMedia({ audio: true, video: { frameRate: { max: limits.maxFrameRate || 30 } } })
        : await acquire(!!m.audio, videoWanted);
    } catch (err) {
      // One call serves both tracks, so say which one the browser refused: try the video alone.
      let which = m.video ? "video" : "audio";
      if (m.audio && videoWanted) {
        try { (await acquire(false, true)).getTracks().forEach((t) => t.stop()); which = "audio"; } catch { which = "video"; }
      }
      fail(which, err);
      return;
    }
    const video = stream.getVideoTracks()[0];
    const audio = stream.getAudioTracks()[0];
    if (m.source.kind === "desktop" && video && !m.video) video.stop();
    if (m.video && video) pumpVideo(video, m.video);
    else if (m.video) fail("video", "the capture has no video track");
    if (m.audio && audio) pumpAudio(audio, m.audio);
    else if (m.audio) fail("audio", "the capture has no audio track");
  }

  // Presentation time in RTP ticks (90 kHz) from the capture clock, made strictly increasing.
  function rtpFor(timestamp) {
    if (firstTimestamp === null) firstTimestamp = timestamp;
    let rtp = Math.round(((timestamp - firstTimestamp) * 90) / 1000) + 90000;
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
    }
  }

  async function pumpVideo(track, params) {
    videoInfo = params;
    videoReader = new MediaStreamTrackProcessor({ track }).readable.getReader();
    let lastAcceptedAt = -1e9;
    captureStats.since = 0;
    for (;;) {
      const { value: frame, done } = await videoReader.read();
      if (done || stopped) { if (frame) frame.close(); return; }
      if (paused) { frame.close(); continue; }
      // The capture may deliver faster than the requested rate (a 60 Hz page); keep the minimum frame interval.
      // It is judged on the capture timestamps: frames that arrive bunched after a stall still carry their regular capture
      // times, and dropping them on arrival time would turn a 30 fps capture into an irregular ~25 fps one.
      const arrivalMs = epochNow();
      const captureMs = frame.timestamp / 1000;
      captureStats.received++;
      if (captureMs - lastAcceptedAt < 0.6 * (1000 / params.frameRate)) { captureStats.limited++; frame.close(); continue; }
      if (lastAcceptedAt > -1e8) captureStats.intervals.push(captureMs - lastAcceptedAt);
      captureStats.arrivalLag.push(arrivalMs - (captureMs + captureOffsetMs(captureMs, arrivalMs)));
      lastAcceptedAt = captureMs;
      reportCaptureStats(arrivalMs);
      const rtp = rtpFor(frame.timestamp);
      // The reference time is the capture time on the epoch clock, not the arrival time: the receiver pairs it with the
      // RTP timestamp in the sender reports, and a jittery arrival would skew that pairing (Chrome stamps frames with
      // the capture begin time, VideoFrameMetadata REFERENCE_TIME).
      const refMs = nextRefMs(captureMs + captureOffsetMs(captureMs, arrivalMs));
      lastCapture = { timestamp: frame.timestamp, refMs };
      if (lastFrameClone) lastFrameClone.close();
      lastFrameClone = frame.clone();
      holdFrame(rtp, frame);
      send({ t: "frame", rtp, refMs, width: frame.displayWidth, height: frame.displayHeight });
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
  let offsetMs = null;
  function captureOffsetMs(captureMs, arrivalMs) {
    const sample = arrivalMs - captureMs;
    offsetMs = offsetMs === null ? sample : Math.min(sample, offsetMs + 0.01);
    return offsetMs;
  }

  // Debug aid, not in Chrome: how steady the capture is, once every five seconds.
  const captureStats = { received: 0, limited: 0, intervals: [], arrivalLag: [], since: 0 };
  function reportCaptureStats(nowMs) {
    if (captureStats.since === 0) captureStats.since = nowMs;
    if (nowMs - captureStats.since < 5000) return;
    const iv = captureStats.intervals.slice().sort((a, b) => a - b);
    const lag = captureStats.arrivalLag.slice().sort((a, b) => a - b);
    const at = (a, q) => (a.length ? Math.round(a[Math.min(a.length - 1, Math.floor(a.length * q))] * 10) / 10 : 0);
    const seconds = (nowMs - captureStats.since) / 1000;
    send({ t: "log", message: "capture: " + Math.round((captureStats.received / seconds) * 10) / 10 + " fps delivered, " + Math.round((iv.length / seconds) * 10) / 10 + " fps kept, " + captureStats.limited + " dropped by the rate limit; capture interval p50 " + at(iv, 0.5) + " ms, p95 " + at(iv, 0.95) + " ms, max " + at(iv, 1) + " ms; delivery delay p50 " + at(lag, 0.5) + " ms, p95 " + at(lag, 0.95) + " ms, max " + at(lag, 1) + " ms" });
    captureStats.received = 0; captureStats.limited = 0; captureStats.intervals = []; captureStats.arrivalLag = []; captureStats.since = nowMs;
  }

  function configureVideo(width, height) {
    if (videoEncoder && videoEncoder.state !== "closed") videoEncoder.close();
    abandonInFlight();
    encoderSize = { width, height };
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
        send({ t: "video-chunk", rtp: info.rtp, key: chunk.type === "key", data, encodeMs: performance.now() - info.startedAt });
      },
      error: (err) => { abandonInFlight(); send({ t: "encoder-status", kind: "video", status: "codec_runtime_error" }); fail("encoder", err); },
    });
    // Chrome's MediaVideoEncoderWrapper asks for a constant bitrate (Bitrate::ConstantBitrate in the constructor and
    // SetBitRate): a variable one is unconstrained in blink (peak = 10x target, VideoEncoder::ParseConfigStatic), so the
    // target the bandwidth logic picks would not hold. It also tunes for screen content except for software VP9
    // (its TODO crbug.com/572902679), which WebCodecs expresses as contentHint "text" (blink maps it to ContentHint::Screen).
    // The framerate is left unset for VP8, which is always software, as Chrome does for software encoders so that the
    // per-frame durations of variable-rate capture drive the rate control.
    const isVp9 = videoCodec.string.indexOf("vp09") === 0 || videoCodec.string === "vp9";
    videoConfig = {
      codec: videoCodec.string,
      width, height,
      bitrate: videoBitrate,
      latencyMode: "realtime",
      bitrateMode: "constant",
      hardwareAcceleration: "no-preference",
    };
    if (!isVp9) videoConfig.contentHint = "text";
    if (videoCodec.string !== "vp8") videoConfig.framerate = videoInfo ? videoInfo.frameRate : 30;
    videoEncoder.configure(videoConfig);
    keyNext = true;
  }

  async function encodeFrame(rtp) {
    const frame = pendingFrames.get(rtp);
    if (!frame) { dropVideo(rtp); return; }
    pendingFrames.delete(rtp);
    try {
      const w = frame.displayWidth, h = frame.displayHeight;
      if (!videoEncoder || videoEncoder.state === "closed" || !encoderSize || encoderSize.width !== w || encoderSize.height !== h) {
        const support = await VideoEncoder.isConfigSupported({ codec: videoCodec.string, width: w, height: h, bitrate: videoBitrate, latencyMode: "realtime" });
        if (!support.supported) { dropVideo(rtp); send({ t: "encoder-status", kind: "video", status: "unsupported_codec" }); return; }
        configureVideo(w, h);
      }
      // A queue that grows means the encoder cannot keep up: skip, the engine sees the missing chunk as a drop.
      if (videoEncoder.encodeQueueSize > 4) { dropVideo(rtp); return; }
      const key = keyNext;
      keyNext = false;
      inFlight.push({ rtp, ts: frame.timestamp, key, startedAt: performance.now() });
      videoEncoder.encode(frame, { keyFrame: key });
    } catch (err) {
      dropVideo(rtp);
      send({ t: "encoder-status", kind: "video", status: "codec_init_failed" });
      fail("encoder", err);
    } finally {
      frame.close();
    }
  }

  async function pumpAudio(track, params) {
    audioReader = new MediaStreamTrackProcessor({ track }).readable.getReader();
    const channels = params.channels, rate = params.sampleRate, block = rate / 100;
    const planes = [];
    for (let c = 0; c < channels; c++) planes.push(new Float32Array(0));
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
    let timestamp = 0;
    let audioClock = null;               // epoch ms of the first sample of the next 10 ms buffer
    for (;;) {
      const { value: data, done } = await audioReader.read();
      if (done || stopped) { if (data) data.close(); return; }
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
        pendingAudio.set(seq, new AudioData({ format: "f32-planar", sampleRate: rate, numberOfFrames: block, numberOfChannels: channels, timestamp, data: buffer }));
        timestamp += 10000;
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
