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
  const pendingFrames = new Map();     // rtp -> VideoFrame, a few frames the engine may ask to encode
  const MAX_PENDING = 3;
  const inFlight = [];                 // { rtp, startedAt } in encoder order
  let lastFrameClone = null;
  let lastRtp = 0;
  let firstTimestamp = null;
  const pendingAudio = new Map();      // seq -> AudioData
  const audioInFlight = [];
  let audioSeq = 0;

  const send = (message, transfer) => port.postMessage(message, transfer || []);
  const fail = (where, error) => send({ t: "error", where, message: String((error && error.message) || error) });

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
        if (videoEncoder && videoEncoder.state === "configured" && encoderSize) configureVideo(encoderSize.width, encoderSize.height);
        return;
      case "set-audio": audioBitrate = m.bps; return;
      case "key-frame": keyNext = true; return;
      case "pause": paused = true; return;
      case "resume": paused = false; return;
      case "refresh":
        if (lastFrameClone) {
          const clone = lastFrameClone.clone();
          lastRtp += 1;
          holdFrame(lastRtp, clone);
          send({ t: "frame", rtp: lastRtp, refMs: epochNow(), width: clone.displayWidth, height: clone.displayHeight });
        }
        return;
      case "encode": return encodeFrame(m.rtp);
      case "encode-audio": return encodeAudio(m.seq);
      case "drop-audio": { const d = pendingAudio.get(m.seq); pendingAudio.delete(m.seq); if (d) d.close(); return; }
      case "stop": return stop();
    }
  }

  async function start(m) {
    try {
      if (m.source.kind === "tab") {
        const mandatory = { chromeMediaSource: "tab", chromeMediaSourceId: m.source.mediaSourceId };
        stream = await navigator.mediaDevices.getUserMedia({
          audio: m.audio ? { mandatory } : false,
          video: m.video ? { mandatory: { ...mandatory, maxWidth: m.video.width, maxHeight: m.video.height, maxFrameRate: m.video.frameRate } } : false,
        });
      } else {
        // The main process answers this call with the chosen source (setDisplayMediaRequestHandler), and loopback audio.
        stream = await navigator.mediaDevices.getDisplayMedia({
          audio: !!m.audio,
          video: { width: { max: m.video ? m.video.width : 1920 }, height: { max: m.video ? m.video.height : 1080 }, frameRate: { max: m.video ? m.video.frameRate : 30 } },
        });
      }
    } catch (err) {
      fail(m.video ? "video" : "audio", err);
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
    for (;;) {
      const { value: frame, done } = await videoReader.read();
      if (done || stopped) { if (frame) frame.close(); return; }
      if (paused) { frame.close(); continue; }
      // The capture may deliver faster than the requested rate (a 60 Hz page); keep the minimum frame interval.
      const nowMs = performance.now();
      if (nowMs - lastAcceptedAt < 0.6 * (1000 / params.frameRate)) { frame.close(); continue; }
      lastAcceptedAt = nowMs;
      if (firstTimestamp === null) firstTimestamp = frame.timestamp;
      // Presentation time in RTP ticks (90 kHz), made strictly increasing.
      let rtp = Math.round(((frame.timestamp - firstTimestamp) * 90) / 1000) + 90000;
      if (rtp <= lastRtp) rtp = lastRtp + 1;
      lastRtp = rtp;
      if (lastFrameClone) lastFrameClone.close();
      lastFrameClone = frame.clone();
      holdFrame(rtp, frame);
      send({ t: "frame", rtp, refMs: epochNow(), width: frame.displayWidth, height: frame.displayHeight });
    }
  }

  function configureVideo(width, height) {
    if (videoEncoder && videoEncoder.state !== "closed") videoEncoder.close();
    encoderSize = { width, height };
    videoEncoder = new VideoEncoder({
      output: (chunk) => {
        const info = inFlight.shift();
        const data = new ArrayBuffer(chunk.byteLength);
        chunk.copyTo(data);
        send({ t: "video-chunk", rtp: info ? info.rtp : 0, key: chunk.type === "key", data, encodeMs: info ? performance.now() - info.startedAt : 0 });
      },
      error: (err) => send({ t: "encoder-status", kind: "video", status: "codec_runtime_error" }) || fail("encoder", err),
    });
    videoEncoder.configure({
      codec: videoCodec.string,
      width, height,
      bitrate: videoBitrate,
      framerate: videoInfo ? videoInfo.frameRate : 30,
      latencyMode: "realtime",
      bitrateMode: "variable",
      hardwareAcceleration: "no-preference",
    });
    keyNext = true;
  }

  async function encodeFrame(rtp) {
    const frame = pendingFrames.get(rtp);
    if (!frame) return;
    pendingFrames.delete(rtp);
    try {
      const w = frame.displayWidth, h = frame.displayHeight;
      if (!videoEncoder || videoEncoder.state === "closed" || !encoderSize || encoderSize.width !== w || encoderSize.height !== h) {
        const support = await VideoEncoder.isConfigSupported({ codec: videoCodec.string, width: w, height: h, bitrate: videoBitrate, latencyMode: "realtime" });
        if (!support.supported) { send({ t: "encoder-status", kind: "video", status: "unsupported_codec" }); return; }
        configureVideo(w, h);
      }
      // A queue that grows means the encoder cannot keep up: skip, the engine sees the missing chunk as a drop.
      if (videoEncoder.encodeQueueSize > 4) return;
      const key = keyNext;
      keyNext = false;
      inFlight.push({ rtp, startedAt: performance.now() });
      videoEncoder.encode(frame, { keyFrame: key });
    } catch (err) {
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
        const data = new ArrayBuffer(chunk.byteLength);
        chunk.copyTo(data);
        send({ t: "audio-chunk", seq: seq === undefined ? 0 : seq, data });
      },
      error: (err) => { send({ t: "encoder-status", kind: "audio", status: "codec_runtime_error" }); fail("encoder", err); },
    });
    try {
      const support = await AudioEncoder.isConfigSupported({ codec: "opus", sampleRate: rate, numberOfChannels: channels, bitrate: audioBitrate });
      if (!support.supported) { send({ t: "encoder-status", kind: "audio", status: "unsupported_codec" }); return; }
      audioEncoder.configure({ codec: "opus", sampleRate: rate, numberOfChannels: channels, bitrate: audioBitrate, opus: { frameDuration: 10000, application: "lowdelay" } });
    } catch (err) { fail("encoder", err); return; }
    let timestamp = 0;
    for (;;) {
      const { value: data, done } = await audioReader.read();
      if (done || stopped) { if (data) data.close(); return; }
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
        send({ t: "audio-buffer", seq, frames: block, recMs: epochNow() });
        if (pendingAudio.size > 50) { const first = pendingAudio.keys().next().value; pendingAudio.get(first).close(); pendingAudio.delete(first); }
      }
    }
  }

  function encodeAudio(seq) {
    const data = pendingAudio.get(seq);
    if (!data) return;
    pendingAudio.delete(seq);
    try { audioInFlight.push(seq); audioEncoder.encode(data); } finally { data.close(); }
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
