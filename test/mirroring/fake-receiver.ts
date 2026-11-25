/**
 * A fake Cast Streaming receiver for tests and the live harness. It answers OFFER with ANSWER and
 * GET_CAPABILITIES with a response, listens on a real UDP socket, optionally drops packets (random loss and a
 * link-rate cap), reassembles and decrypts frames with the negotiated AES key and IV mask, validates the VP8 and
 * Opus payloads, and sends RTCP receiver reports, checkpoint ACKs, per-frame ACKs and NACKs back to the sender.
 *
 * It exists so that nothing here ever has to talk to a real Cast device.
 */
import { createSocket, type Socket, type RemoteInfo } from "node:dgram";
import { performance } from "node:perf_hooks";
import { ALL_PACKETS_LOST } from "../../src/mirroring/protocol/constants.ts";
import { FrameCrypto } from "../../src/mirroring/rtp/frame-crypto.ts";
import { NtpTimeConverter } from "../../src/mirroring/rtcp/ntp.ts";
import { buildReceiverRtcp, parseRtpPacket } from "./receiver-wire.ts";
import { validateOpusPacket, validateVp8Frame } from "./media-validate.ts";

export interface FakeReceiverOptions {
  /** Probability of dropping each incoming RTP packet. */
  lossRate?: number;
  /** Link rate cap in bits per second; packets over it are dropped (a 8 KB queue). */
  linkBitsPerSecond?: number;
  random?: () => number;
  /** Video codec names to pick from the OFFER, in order. */
  videoPreference?: string[];
  playoutDelayMs?: number;
  /** Check the bodies produced by the test encoder (`fakeFrameBody`). */
  verifyBody?: boolean;
  /** Stop answering feedback (to test the sender with a silent receiver). */
  silent?: boolean;
  /** Build the CAPABILITIES_RESPONSE body instead of the default, or send no reply when `null`. */
  capabilitiesResponse?: ((seqNum: unknown) => Record<string, unknown>) | null;
  /** Run on a virtual clock and in-memory network instead of the wall clock and a UDP socket (virtual-time.ts). */
  net?: ReceiverNet;
}

/** What the receiver needs from a virtual network. */
export interface ReceiverNet {
  now(): number;
  setInterval(cb: () => void, ms: number): () => void;
  /** Send an RTCP packet to the sender. */
  toSender(packet: Buffer): void;
}

interface FrameAssembly {
  maxPacketId: number;
  packets: Map<number, Buffer>;
  isKey: boolean;
  referencedFrameId: number;
  rtpTimestamp: number;
  lastPacketAt: number;
  lastNackAt: Map<number, number>;
}

interface StreamState {
  index: number;
  kind: "audio" | "video";
  codec: string;
  senderSsrc: number;
  receiverSsrc: number;
  payloadType: number;
  crypto: FrameCrypto;
  /** Highest frame id whose frames are all complete. */
  checkpoint: number;
  highest: number;
  frames: Map<number, FrameAssembly>;
  completed: Set<number>;
  lastSr: { middle: number; arrivalMs: number } | undefined;
  dirty: boolean;
  lastFeedbackAt: number;
}

export interface FakeReceiverStats {
  packetsReceived: number;
  packetsDroppedByLoss: number;
  packetsDroppedByLink: number;
  bytesReceived: number;
  retransmissionsReceived: number;
  nackedPackets: number;
  videoFrames: number;
  audioFrames: number;
  validVideoFrames: number;
  validAudioFrames: number;
  videoKeyFrames: number;
  invalidFrames: number;
  videoBytes: number;
  /** Opus payload bytes: a silent buffer encodes to a few bytes, a tone to hundreds. */
  audioBytes: number;
  firstFrameAt?: number;
  lastFrameAt?: number;
}

/** Deterministic frame body used by the test encoders so that decryption can be proven byte for byte. */
export function fakeFrameBody(seed: number, length: number): Buffer {
  const b = Buffer.alloc(length);
  let x = (seed * 2654435761) >>> 0;
  for (let i = 0; i < length; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    b[i] = (x >>> 16) & 0xff;
  }
  return b;
}

export class FakeReceiver {
  readonly stats: FakeReceiverStats = {
    packetsReceived: 0,
    packetsDroppedByLoss: 0,
    packetsDroppedByLink: 0,
    bytesReceived: 0,
    retransmissionsReceived: 0,
    nackedPackets: 0,
    videoFrames: 0,
    audioFrames: 0,
    audioBytes: 0,
    validVideoFrames: 0,
    validAudioFrames: 0,
    videoKeyFrames: 0,
    invalidFrames: 0,
    videoBytes: 0,
  };
  /** Decrypted video frames, in completion order (kept only if `keepFrames`). */
  readonly decodedVideo: { frameId: number; data: Buffer }[] = [];
  keepFrames = false;
  capabilityRequests = 0;
  /** Called with every control message (JSON text) the receiver sends back. */
  sendControl: (json: string) => void = () => {};
  private readonly opts: Required<Pick<FakeReceiverOptions, "lossRate" | "playoutDelayMs">> & FakeReceiverOptions;
  private readonly socket: Socket | undefined;
  private readonly net: ReceiverNet | undefined;
  private cancelNetTimer: (() => void) | undefined;
  private port = 0;
  private readonly streams = new Map<number, StreamState>();
  private readonly ntp: NtpTimeConverter;
  private senderEndpoint: { address: string; port: number } | undefined;
  private timer: NodeJS.Timeout | undefined;
  private tokens = 8192;
  private tokensAt: number;
  private readonly random: () => number;
  /** The most recent OFFER's streams, for tests that want to look at them. */
  lastOffer: Record<string, unknown> | undefined;

  private constructor(opts: FakeReceiverOptions) {
    this.opts = { lossRate: 0, playoutDelayMs: 200, ...opts };
    this.random = opts.random ?? Math.random;
    this.net = opts.net;
    this.socket = opts.net === undefined ? createSocket("udp4") : undefined;
    // A fixed wall-clock origin under a virtual clock keeps the NTP timestamps identical from run to run.
    this.ntp = new NtpTimeConverter(this.clockNow(), opts.net === undefined ? Date.now() / 1000 : 1_700_000_000);
    this.tokensAt = this.clockNow();
  }

  private clockNow(): number {
    return this.net !== undefined ? this.net.now() : performance.now();
  }

  /** A packet arriving from the sender over the virtual network. */
  deliver(packet: Buffer): void {
    this.onPacket(packet, { address: "virtual", port: 1 } as RemoteInfo);
  }

  static async create(opts: FakeReceiverOptions = {}): Promise<FakeReceiver> {
    const r = new FakeReceiver(opts);
    if (r.net !== undefined) {
      r.port = 40000;
      r.cancelNetTimer = r.net.setInterval(() => r.tick(), 10);
      return r;
    }
    const socket = r.socket!;
    await new Promise<void>((resolve) => socket.bind(0, "127.0.0.1", resolve));
    r.port = socket.address().port;
    socket.on("message", (msg, rinfo) => r.onPacket(msg, rinfo));
    r.timer = setInterval(() => r.tick(), 10);
    return r;
  }

  get udpPort(): number {
    return this.port;
  }

  close(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    this.cancelNetTimer?.();
    this.cancelNetTimer = undefined;
    this.socket?.close();
  }

  /** The OFFER, GET_CAPABILITIES and RPC/INPUT messages from the sender. */
  onControlMessage(namespace: string, text: string): void {
    void namespace;
    const message = JSON.parse(text) as Record<string, unknown>;
    switch (message.type) {
      case "OFFER":
        this.onOffer(message);
        break;
      case "GET_CAPABILITIES":
        this.capabilityRequests++;
        if (this.opts.capabilitiesResponse === null) break;
        this.sendControl(JSON.stringify((this.opts.capabilitiesResponse?.(message.seqNum) ?? { type: "CAPABILITIES_RESPONSE", seqNum: message.seqNum, result: "ok", capabilities: { remoting: 2, mediaCaps: ["audio", "opus", "video", "vp8"] } })));
        break;
      default:
        break;
    }
  }

  private onOffer(message: Record<string, unknown>): void {
    this.lastOffer = message;
    const offer = message.offer as { supportedStreams: Record<string, unknown>[] };
    const streams = offer.supportedStreams;
    const sendIndexes: number[] = [];
    const ssrcs: number[] = [];
    this.streams.clear();
    const audio = streams.find((s) => s.type === "audio_source" && s.codecName === "opus");
    const videoPref = this.opts.videoPreference ?? ["vp8"];
    let video: Record<string, unknown> | undefined;
    for (const name of videoPref) {
      video = streams.find((s) => s.type === "video_source" && s.codecName === name);
      if (video !== undefined) break;
    }
    for (const [i, s] of [audio, video].entries()) {
      if (s === undefined) continue;
      const receiverSsrc = 700 + i;
      sendIndexes.push(s.index as number);
      ssrcs.push(receiverSsrc);
      this.streams.set(s.ssrc as number, {
        index: s.index as number,
        kind: s.type === "audio_source" ? "audio" : "video",
        codec: s.codecName as string,
        senderSsrc: s.ssrc as number,
        receiverSsrc,
        payloadType: s.rtpPayloadType as number,
        crypto: new FrameCrypto(Buffer.from(s.aesKey as string, "hex"), Buffer.from(s.aesIvMask as string, "hex")),
        checkpoint: -1,
        highest: -1,
        frames: new Map(),
        completed: new Set(),
        lastSr: undefined,
        dirty: false,
        lastFeedbackAt: 0,
      });
    }
    if (sendIndexes.length === 0) {
      this.sendControl(JSON.stringify({ type: "ANSWER", seqNum: message.seqNum, result: "error", error: { code: 10107, description: "no stream selected" } }));
      return;
    }
    this.sendControl(JSON.stringify({ type: "ANSWER", seqNum: message.seqNum, result: "ok", answer: { udpPort: this.port, sendIndexes, ssrcs } }));
  }

  private onPacket(buf: Buffer, rinfo: RemoteInfo): void {
    this.senderEndpoint = { address: rinfo.address, port: rinfo.port };
    const now = this.clockNow();
    // RTCP sender report.
    if (buf.length >= 28 && buf[0] === 0x80 && buf[1] === 200) {
      const stream = this.streams.get(buf.readUInt32BE(4));
      if (stream !== undefined) {
        stream.lastSr = { middle: Number((buf.readBigUInt64BE(8) >> 16n) & 0xffffffffn), arrivalMs: now };
        stream.dirty = true;
      }
      return;
    }
    const rtp = parseRtpPacket(buf);
    if (rtp === undefined) return;
    this.stats.packetsReceived++;
    // The simulated network: link rate cap, then random loss.
    if (this.opts.linkBitsPerSecond !== undefined) {
      const rate = this.opts.linkBitsPerSecond / 8;
      this.tokens = Math.min(8192, this.tokens + ((now - this.tokensAt) / 1000) * rate);
      this.tokensAt = now;
      if (this.tokens < buf.length) {
        this.stats.packetsDroppedByLink++;
        return;
      }
      this.tokens -= buf.length;
    }
    if (this.opts.lossRate > 0 && this.random() < this.opts.lossRate) {
      this.stats.packetsDroppedByLoss++;
      return;
    }
    this.stats.bytesReceived += buf.length;
    const stream = this.streams.get(rtp.ssrc);
    if (stream === undefined) return;
    // Expand the 8-bit frame id relative to the first frame not yet complete.
    const base = stream.checkpoint + 1;
    const delta = (((rtp.frameId - (base & 0xff) + 128) & 0xff) - 128);
    const frameId = base + delta;
    if (frameId <= stream.checkpoint || stream.completed.has(frameId)) {
      this.stats.retransmissionsReceived++;
      return;
    }
    let frame = stream.frames.get(frameId);
    if (frame === undefined) {
      frame = { maxPacketId: rtp.maxPacketId, packets: new Map(), isKey: rtp.isKeyFrame, referencedFrameId: rtp.referencedFrameId, rtpTimestamp: rtp.rtpTimestamp, lastPacketAt: now, lastNackAt: new Map() };
      stream.frames.set(frameId, frame);
    }
    if (frame.packets.has(rtp.packetId)) {
      this.stats.retransmissionsReceived++;
      return;
    }
    if (frame.lastNackAt.has(rtp.packetId)) this.stats.retransmissionsReceived++;
    frame.packets.set(rtp.packetId, rtp.payload);
    frame.lastPacketAt = now;
    stream.highest = Math.max(stream.highest, frameId);
    stream.dirty = true;
    if (frame.packets.size === frame.maxPacketId + 1) this.completeFrame(stream, frameId, frame, now);
  }

  private completeFrame(stream: StreamState, frameId: number, frame: FrameAssembly, now: number): void {
    const chunks: Buffer[] = [];
    for (let p = 0; p <= frame.maxPacketId; p++) chunks.push(frame.packets.get(p)!);
    const data = stream.crypto.decrypt(frameId, chunks);
    stream.frames.delete(frameId);
    stream.completed.add(frameId);
    while (stream.completed.has(stream.checkpoint + 1)) {
      stream.checkpoint++;
      stream.completed.delete(stream.checkpoint);
    }
    stream.dirty = true;
    this.stats.firstFrameAt ??= now;
    this.stats.lastFrameAt = now;
    if (stream.kind === "video") {
      this.stats.videoFrames++;
      this.stats.videoBytes += data.length;
      const info = stream.codec === "vp8" ? validateVp8Frame(data) : { key: frame.isKey };
      const ok = info !== undefined && info.key === frame.isKey && this.bodyOk(frame, data, 10);
      if (ok) this.stats.validVideoFrames++;
      else this.stats.invalidFrames++;
      if (info?.key === true) this.stats.videoKeyFrames++;
      if (this.keepFrames) this.decodedVideo.push({ frameId, data });
    } else {
      this.stats.audioFrames++;
      this.stats.audioBytes += data.length;
      if (validateOpusPacket(data) && this.bodyOk(frame, data, 1)) this.stats.validAudioFrames++;
      else this.stats.invalidFrames++;
    }
  }

  private bodyOk(frame: FrameAssembly, data: Buffer, headerLength: number): boolean {
    if (this.opts.verifyBody !== true) return true;
    return fakeFrameBody(frame.rtpTimestamp, data.length - headerLength).equals(data.subarray(headerLength));
  }

  /** Send feedback for streams with news, and at least every 100 ms. */
  private tick(): void {
    if (this.opts.silent === true || this.senderEndpoint === undefined) return;
    const now = this.clockNow();
    for (const stream of this.streams.values()) {
      if (!stream.dirty && now - stream.lastFeedbackAt < 100) continue;
      if (now - stream.lastFeedbackAt < 20) continue;
      this.sendFeedback(stream, now);
    }
  }

  private sendFeedback(stream: StreamState, now: number): void {
    const nacks: { frameId: number; packetId: number }[] = [];
    for (let id = stream.checkpoint + 1; id <= stream.highest && nacks.length < 60; id++) {
      const frame = stream.frames.get(id);
      if (frame === undefined) {
        if (!stream.completed.has(id)) nacks.push({ frameId: id, packetId: ALL_PACKETS_LOST });
        continue;
      }
      // Wait for stragglers of the newest frame before calling packets lost.
      if (id === stream.highest && now - frame.lastPacketAt < 15) continue;
      for (let p = 0; p <= frame.maxPacketId && nacks.length < 60; p++) {
        if (frame.packets.has(p)) continue;
        const last = frame.lastNackAt.get(p);
        if (last !== undefined && now - last < 60) continue;
        frame.lastNackAt.set(p, now);
        nacks.push({ frameId: id, packetId: p });
      }
    }
    // A NACK list that mixes "all lost" with individual packets of other frames is fine; it only needs sorting.
    nacks.sort((a, b) => a.frameId - b.frameId || a.packetId - b.packetId);
    this.stats.nackedPackets += nacks.length;
    const acks = [...stream.completed].sort((a, b) => a - b);
    const sr = stream.lastSr;
    const rtcp = buildReceiverRtcp({
      receiverSsrc: stream.receiverSsrc,
      senderSsrc: stream.senderSsrc,
      ntp: this.ntp,
      sendTimeMs: now,
      reportBlock:
        sr === undefined
          ? undefined
          : {
              ssrc: stream.senderSsrc,
              packetFractionLostNumerator: 0,
              cumulativePacketsLost: 0,
              extendedHighSequenceNumber: 0,
              jitter: 0,
              lastStatusReportId: sr.middle,
              delaySinceLastReport: Math.round(((now - sr.arrivalMs) * 65536) / 1000),
            },
      checkpointFrameId: stream.checkpoint,
      playoutDelayMs: this.opts.playoutDelayMs,
      nacks,
      acks,
    });
    stream.dirty = false;
    stream.lastFeedbackAt = now;
    if (this.net !== undefined) this.net.toSender(rtcp);
    else this.socket!.send(rtcp, this.senderEndpoint!.port, this.senderEndpoint!.address);
  }
}
