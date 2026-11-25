/**
 * Negotiation and sender setup, ported from openscreen `cast/streaming/public/sender_session.cc` (`SenderSession`):
 * it builds the mirroring OFFER, sends it, turns the ANSWER into configured `Sender`s on the shared packet router,
 * reports errors the way `SenderSession::Client::OnError` expects, and asks for the receiver's capabilities.
 *
 * Remoting offers (`NegotiateRemoting`), data transport and DSCP marking are not ported: this library mirrors only.
 */
import { MIN_VIDEO_HEIGHT, MIN_VIDEO_WIDTH, DEFAULT_VIDEO_MIN_BIT_RATE } from "../protocol/constants.ts";
import { audioPayloadType, createAudioStream, createVideoStream, getCapabilitiesMessage, offerMessage, videoPayloadType, type AudioCaptureConfig, type Offer, type VideoCaptureConfig } from "../protocol/offer.ts";
import { fractionToNumber } from "../protocol/offer.ts";
import type { Answer, ReceiverCapability } from "../protocol/answer.ts";
import { getRecommendations, type Recommendations } from "../protocol/recommendations.ts";
import { ErrorCode, SessionError, receiverErrorToError } from "../protocol/errors.ts";
import { SenderSessionMessenger, type MessagePort, type MessengerTimers } from "../protocol/messenger.ts";
import type { SenderEnvironment, SenderPacketRouter } from "./packet-router.ts";
import { Sender, type SessionConfig } from "./sender.ts";
import { StatisticsAnalyzer } from "../stats/statistics-analyzer.ts";
import type { SenderStatsClient } from "../stats/statistics.ts";


/** The environment as `SenderSession` uses it: the router's, plus the UDP destination learned from the ANSWER. */
export interface SessionEnvironment extends SenderEnvironment {
  setRemoteEndpoint(address: string, port: number): void;
}

export interface ConfiguredSenders {
  audioSender?: Sender;
  audioConfig?: AudioCaptureConfig;
  videoSender?: Sender;
  videoConfig?: VideoCaptureConfig;
}

/** `SenderSession::Client`. */
export interface SenderSessionClient {
  onNegotiated(session: SenderSession, senders: ConfiguredSenders, recommendations: Recommendations): void;
  onCapabilitiesDetermined?(session: SenderSession, capabilities: RemotingCapabilities): void;
  onError(session: SenderSession, error: SessionError): void;
}

export interface SenderSessionConfig {
  remoteAddress: string;
  client: SenderSessionClient;
  environment: SessionEnvironment;
  router: SenderPacketRouter;
  messagePort: MessagePort;
  messageSourceId: string;
  messageDestinationId: string;
  timers: MessengerTimers;
  /** `use_android_rtp_hack`; true by default as in `SenderSession::Configuration`. */
  useAndroidRtpHack?: boolean;
}

/** openscreen `RemotingCapabilities`: `AudioCapability` and `VideoCapability` names as `ToCapabilities` produces them. */
export interface RemotingCapabilities {
  audio: ("baseline" | "aac" | "opus")[];
  video: ("4k" | "h264" | "vp8" | "vp9" | "hevc" | "av1")[];
}

/** sender_session.cc `ToCapabilities`: the plain "video" capability is ignored (Chrome remoting does not use it). */
export function toCapabilities(capability: ReceiverCapability): RemotingCapabilities {
  const out: RemotingCapabilities = { audio: [], video: [] };
  for (const c of capability.mediaCapabilities) {
    switch (c) {
      case "audio":
        out.audio.push("baseline");
        break;
      case "aac":
      case "opus":
        out.audio.push(c);
        break;
      case "4k":
      case "h264":
      case "vp8":
      case "vp9":
      case "hevc":
      case "av1":
        out.video.push(c);
        break;
      case "video":
        break;
    }
  }
  return out;
}

/** `kSupportedRemotingVersion`. */
export const SUPPORTED_REMOTING_VERSION = 2;

/** `IsValidAudioCaptureConfig`. */
function isValidAudioCaptureConfig(config: AudioCaptureConfig): boolean {
  return config.channels >= 1 && config.bitRate >= 0;
}

/** `IsValidVideoCaptureConfig`: positive frame rate, a bit rate of 0 or at least the minimum, supported resolutions. */
function isValidVideoCaptureConfig(config: VideoCaptureConfig): boolean {
  return (
    fractionToNumber(config.maxFrameRate) > 0 &&
    (config.maxBitRate === 0 || config.maxBitRate >= DEFAULT_VIDEO_MIN_BIT_RATE) &&
    config.resolutions.length > 0 &&
    config.resolutions.every((r) => r.width >= MIN_VIDEO_WIDTH && r.height >= MIN_VIDEO_HEIGHT)
  );
}

interface Negotiation {
  offer: Offer;
  audioConfigs: AudioCaptureConfig[];
  videoConfigs: VideoCaptureConfig[];
}

export class SenderSession {
  private readonly config: SenderSessionConfig;
  private readonly messenger: SenderSessionMessenger;
  private readonly useAndroidRtpHack: boolean;
  private negotiation: Negotiation | undefined;
  private sequenceNumber = 0;
  private statsAnalyzer: StatisticsAnalyzer | undefined;
  state: "idle" | "streaming" = "idle";

  constructor(config: SenderSessionConfig) {
    this.config = config;
    this.useAndroidRtpHack = config.useAndroidRtpHack ?? true;
    this.messenger = new SenderSessionMessenger(
      config.messagePort,
      config.messageSourceId,
      config.messageDestinationId,
      (error) => config.client.onError(this, error),
      config.timers,
    );
  }

  /** Feed a message received from the receiver (the `MessagePort::Client::OnMessage` side). */
  onMessage(sourceId: string, messageNamespace: string, message: string): void {
    this.messenger.onMessage(sourceId, messageNamespace, message);
  }

  get remotingMessenger(): SenderSessionMessenger {
    return this.messenger;
  }

  /** `Negotiate`: returns an error for an invalid call, otherwise the result arrives through the client. */
  negotiate(audioConfigs: AudioCaptureConfig[], videoConfigs: VideoCaptureConfig[]): SessionError | undefined {
    if (audioConfigs.length === 0 && videoConfigs.length === 0) {
      return new SessionError(ErrorCode.ParameterInvalid, "Need at least one audio or video config to negotiate.");
    }
    if (!audioConfigs.every(isValidAudioCaptureConfig) || !videoConfigs.every(isValidVideoCaptureConfig)) {
      return new SessionError(ErrorCode.ParameterInvalid, "Invalid configs provided.");
    }
    // CreateMirroringOffer: stream indexes are [0..audio) then [audio..audio+video).
    const opts = { useAndroidRtpHack: this.useAndroidRtpHack, supportsInputEvents: false };
    const offer: Offer = {
      castMode: "mirroring",
      audioStreams: audioConfigs.map((c, i) => createAudioStream(i, c, opts)),
      videoStreams: videoConfigs.map((c, i) => createVideoStream(audioConfigs.length + i, c, opts)),
    };
    this.negotiation = { offer, audioConfigs, videoConfigs };
    this.messenger.sendRequest(offerMessage(++this.sequenceNumber, offer) as Record<string, unknown> & { seqNum: number }, "ANSWER", (reply) => this.onAnswer(reply));
    return undefined;
  }

  /** `RequestCapabilities`. */
  requestCapabilities(): void {
    this.messenger.sendRequest(getCapabilitiesMessage(++this.sequenceNumber) as Record<string, unknown> & { seqNum: number }, "CAPABILITIES_RESPONSE", (reply) => this.onCapabilitiesResponse(reply));
  }

  /**
   * `SetStatsClient`: from now on the environment reports every packet sent, the senders report their frame events and
   * the receiver's RTCP event log, and the client gets the analyzed statistics every 500 ms. Once only.
   */
  setStatsClient(client: SenderStatsClient): void {
    if (this.statsAnalyzer !== undefined) throw new Error("the stats client should only be set once");
    const env = this.config.environment;
    const analyzer = new StatisticsAnalyzer(client, () => env.now(), (atMs, cb) => env.schedule(atMs, cb));
    this.statsAnalyzer = analyzer;
    env.statisticsCollector = analyzer.statisticsCollector;
    analyzer.scheduleAnalysis();
  }

  /** The destructor: statistics stop (`SetStatisticsCollector(nullptr)`) and so does the analysis timer. */
  dispose(): void {
    this.config.environment.statisticsCollector = undefined;
    this.statsAnalyzer?.dispose();
  }

  /** `GetEstimatedNetworkBandwidth`. */
  getEstimatedNetworkBandwidth(): number {
    return this.config.router.computeNetworkBandwidth();
  }

  private resetState(): void {
    this.state = "idle";
    this.negotiation = undefined;
  }

  /** `OnAnswer`. */
  private onAnswer(reply: Parameters<Parameters<SenderSessionMessenger["sendRequest"]>[2]>[0]): void {
    if (reply instanceof SessionError) {
      this.resetState();
      // Answer timeouts are reported with their own code so that callers can track them.
      this.config.client.onError(this, reply.code === ErrorCode.MessageTimeout ? new SessionError(ErrorCode.AnswerTimeout, "Didn't receive an ANSWER message before timeout.") : reply);
      return;
    }
    if (!reply.valid || reply.type !== "ANSWER") {
      this.resetState();
      this.handleErrorMessage(reply, ErrorCode.InvalidAnswer, "Invalid ANSWER message.");
      return;
    }
    const answer = reply.answer;
    // SelectSenders reads `answer.ssrcs[i]` for every send index without checking the length (an out-of-range read in
    // C++); a receiver that sends fewer ssrcs than indexes is malformed, so the answer is refused.
    if (answer.ssrcs.length < answer.sendIndexes.length) {
      this.resetState();
      this.config.client.onError(this, new SessionError(ErrorCode.InvalidAnswer, "Invalid ANSWER message: fewer ssrcs than send indexes."));
      return;
    }
    const senders = this.selectSenders(answer);
    if (senders.audioSender === undefined && senders.videoSender === undefined) {
      this.resetState();
      this.config.client.onError(this, new SessionError(ErrorCode.NoStreamSelected, "Invalid answer response message"));
      return;
    }
    const recommendations = getRecommendations(answer);
    this.state = "streaming";
    this.config.client.onNegotiated(this, senders, recommendations);
  }

  /** `OnCapabilitiesResponse`. */
  private onCapabilitiesResponse(reply: Parameters<Parameters<SenderSessionMessenger["sendRequest"]>[2]>[0]): void {
    // Some receivers send no response, or an error, to indicate that remoting is not supported.
    if (reply instanceof SessionError) {
      this.config.client.onError(this, new SessionError(ErrorCode.RemotingNotSupported, reply.message));
      return;
    }
    if (!reply.valid || reply.type !== "CAPABILITIES_RESPONSE") {
      this.handleErrorMessage(reply, ErrorCode.RemotingNotSupported, "Invalid CAPABILITIES_RESPONSE message, assuming remoting is not supported");
      return;
    }
    const caps = reply.capabilities;
    const version = caps.remotingVersion === -1 ? 1 : caps.remotingVersion;
    if (version > SUPPORTED_REMOTING_VERSION) {
      this.config.client.onError(this, new SessionError(ErrorCode.RemotingNotSupported, `Receiver is using too new of a version for remoting (${version} > ${SUPPORTED_REMOTING_VERSION})`));
      return;
    }
    this.config.client.onCapabilitiesDetermined?.(this, toCapabilities(caps));
  }

  /**
   * `HandleErrorMessage`: an error ANSWER other than NoStreamSelected is reported as the default error so callers can
   * tell a rejected offer from a transport or session error.
   */
  private handleErrorMessage(reply: Exclude<Parameters<Parameters<SenderSessionMessenger["sendRequest"]>[2]>[0], SessionError>, defaultCode: number, defaultMessage: string): void {
    if (!reply.valid && reply.error !== undefined) {
      let converted = receiverErrorToError(reply.error);
      if (converted.code === ErrorCode.UnknownError || (reply.type === "ANSWER" && converted.code !== ErrorCode.NoStreamSelected)) {
        converted = new SessionError(defaultCode, converted.message);
      }
      this.config.client.onError(this, converted);
    } else {
      this.config.client.onError(this, new SessionError(defaultCode, defaultMessage));
    }
  }

  /** `CreateSender`. */
  private createSender(receiverSsrc: number, stream: Offer["audioStreams"][number]["stream"], payloadType: number, streamType: "audio" | "video"): Sender {
    const config: SessionConfig = {
      senderSsrc: stream.ssrc,
      receiverSsrc,
      rtpTimebase: stream.rtpTimebase,
      channels: stream.channels,
      targetPlayoutDelayMs: stream.targetDelayMs,
      aesSecretKey: stream.aesKey,
      aesIvMask: stream.aesIvMask,
      isPliEnabled: true,
      streamType,
    };
    return new Sender(this.config.environment, this.config.router, config, payloadType);
  }

  /** `SelectSenders`: the destination UDP port comes from the ANSWER, the address from the receiver's TLS address. */
  private selectSenders(answer: Answer): ConfiguredSenders {
    const negotiation = this.negotiation!;
    this.config.environment.setRemoteEndpoint(this.config.remoteAddress, answer.udpPort);
    const senders: ConfiguredSenders = {};
    const audioSize = negotiation.audioConfigs.length;
    const videoSize = negotiation.videoConfigs.length;
    for (let i = 0; i < answer.sendIndexes.length; i++) {
      const receiverSsrc = answer.ssrcs[i]!;
      const sendIndex = answer.sendIndexes[i]!;
      if (sendIndex < audioSize) {
        const cfg = negotiation.audioConfigs[sendIndex]!;
        const stream = negotiation.offer.audioStreams.find((s) => s.stream.index === sendIndex);
        if (stream !== undefined) {
          senders.audioSender = this.createSender(receiverSsrc, stream.stream, audioPayloadType(cfg.codec, this.useAndroidRtpHack), "audio");
          senders.audioConfig = cfg;
        }
      } else if (sendIndex < audioSize + videoSize) {
        const cfg = negotiation.videoConfigs[sendIndex - audioSize]!;
        const stream = negotiation.offer.videoStreams.find((s) => s.stream.index === sendIndex);
        if (stream !== undefined) {
          senders.videoSender = this.createSender(receiverSsrc, stream.stream, videoPayloadType(cfg.codec, this.useAndroidRtpHack), "video");
          senders.videoConfig = cfg;
        }
      }
    }
    return senders;
  }
}
