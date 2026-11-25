/**
 * The sender's side of the Cast Streaming control channel, ported from openscreen
 * `cast/streaming/public/session_messenger.cc` (`SessionMessenger`, `SenderSessionMessenger`): it posts messages in
 * the `webrtc` or `remoting` namespace through a `MessagePort`, matches ANSWER and CAPABILITIES_RESPONSE replies to
 * requests by sequence number with a 4 s timeout, and passes RPC and INPUT through to their handlers.
 */
import { CAST_REMOTING_NAMESPACE, CAST_WEBRTC_NAMESPACE } from "./constants.ts";
import { MessageParseError, parseReceiverMessage, type ReceiverMessage } from "./answer.ts";
import { ErrorCode, SessionError } from "./errors.ts";

/** `kReplyTimeout`. */
export const REPLY_TIMEOUT_MS = 4000;
/** `kAnyDestination`. */
const ANY_DESTINATION = "*";

/** The channel the messenger posts through: openscreen `MessagePort` (message_port.h). */
export interface MessagePort {
  postMessage(destinationId: string, messageNamespace: string, message: string): void;
}

export type ReplyCallback = (message: ReceiverMessage | SessionError) => void;
export type ReplyType = "ANSWER" | "CAPABILITIES_RESPONSE";

export interface MessengerTimers {
  /** Run `cb` after `delayMs`; returns a cancel function. */
  setTimeout(cb: () => void, delayMs: number): () => void;
}

export class SenderSessionMessenger {
  private readonly port: MessagePort;
  private readonly sourceId: string;
  private readonly receiverId: string;
  private readonly onError: (error: SessionError) => void;
  private readonly timers: MessengerTimers;
  private readonly awaiting = new Map<number, ReplyCallback>();
  private rpcHandler: ((message: ReceiverMessage) => void) | undefined;
  private inputHandler: ((message: ReceiverMessage) => void) | undefined;

  constructor(port: MessagePort, sourceId: string, receiverId: string, onError: (error: SessionError) => void, timers: MessengerTimers) {
    if (sourceId === "") throw new Error("source id must not be empty");
    this.port = port;
    this.sourceId = sourceId;
    this.receiverId = receiverId;
    this.onError = onError;
    this.timers = timers;
  }

  /** `SetHandler`: only RPC and INPUT take handlers. */
  setHandler(type: "RPC" | "INPUT", cb: (message: ReceiverMessage) => void): void {
    if (type === "RPC") this.rpcHandler = cb;
    else this.inputHandler = cb;
  }

  resetHandler(type: "RPC" | "INPUT"): void {
    if (type === "RPC") this.rpcHandler = undefined;
    else this.inputHandler = undefined;
  }

  /** `SendOutboundMessage`: RPC and INPUT go to the remoting namespace, everything else to webrtc. */
  private sendOutbound(message: Record<string, unknown>): void {
    const type = message.type;
    const ns = type === "RPC" || type === "INPUT" ? CAST_REMOTING_NAMESPACE : CAST_WEBRTC_NAMESPACE;
    this.port.postMessage(this.receiverId, ns, JSON.stringify(message));
  }

  /** `SendRpcMessage` (sender_message.cc: `{type: "RPC", rpc: base64}`). */
  sendRpcMessage(data: Uint8Array): void {
    this.sendOutbound({ type: "RPC", rpc: Buffer.from(data).toString("base64") });
  }

  /** `SendInputMessage`. */
  sendInputMessage(data: Uint8Array): void {
    this.sendOutbound({ type: "INPUT", input: Buffer.from(data).toString("base64") });
  }

  /** `SendRequest`: the callback gets the reply, or a `MessageTimeout` error after 4 s. */
  sendRequest(message: Record<string, unknown> & { seqNum: number }, replyType: ReplyType, cb: ReplyCallback): void {
    void replyType; // Replies are matched on the sequence number alone, as in the C++.
    this.sendOutbound(message);
    this.awaiting.set(message.seqNum, cb);
    this.timers.setTimeout(() => {
      const pending = this.awaiting.get(message.seqNum);
      if (pending === undefined) return;
      this.awaiting.delete(message.seqNum);
      pending(new SessionError(ErrorCode.MessageTimeout, `message timed out; max delay of ${REPLY_TIMEOUT_MS} ms`));
    }, REPLY_TIMEOUT_MS);
  }

  /** `OnMessage`. */
  onMessage(sourceId: string, messageNamespace: string, message: string): void {
    if (sourceId !== this.receiverId && sourceId !== ANY_DESTINATION) return;
    if (messageNamespace !== CAST_WEBRTC_NAMESPACE && messageNamespace !== CAST_REMOTING_NAMESPACE) return;
    let body: unknown;
    try {
      body = JSON.parse(message);
    } catch (e) {
      this.onError(new SessionError(ErrorCode.JsonParseError, (e as Error).message));
      return;
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      this.onError(new SessionError(ErrorCode.JsonParseError, "message is not a JSON object"));
      return;
    }
    let parsed: ReceiverMessage;
    try {
      parsed = parseReceiverMessage(body);
    } catch (e) {
      const code = e instanceof MessageParseError ? ErrorCode.ParameterInvalid : ErrorCode.UnknownError;
      this.onError(new SessionError(code, (e as Error).message));
      return;
    }
    if (parsed.type === "RPC") {
      this.rpcHandler?.(parsed);
    } else if (parsed.type === "INPUT") {
      this.inputHandler?.(parsed);
    } else {
      const cb = this.awaiting.get(parsed.seqNum);
      if (cb === undefined) return;
      this.awaiting.delete(parsed.seqNum);
      cb(parsed);
    }
  }

  /** The id this messenger is the source of. */
  get source(): string {
    return this.sourceId;
  }
}
