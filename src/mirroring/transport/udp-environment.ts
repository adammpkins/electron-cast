/**
 * The UDP side of the sender, ported from openscreen `cast/streaming/public/environment.cc` (`Environment`):
 * one UDP socket bound to an ephemeral port, packets sent to the remote endpoint the ANSWER announced
 * (`SendPacket`), packets received only from exactly that endpoint (`SenderPacketRouter::OnReceivedPacket`), and the
 * maximum packet size by address family (`GetMaxPacketSize`).
 *
 * Time is `performance.now()` in milliseconds (a monotonic clock, as `openscreen::Clock::now`); timers are Node timers.
 * Node's `dgram` is the only dependency, so this runs unchanged in an Electron `utilityProcess` or in a test.
 */
import { createSocket, type Socket } from "node:dgram";
import { isIPv6 } from "node:net";
import { performance } from "node:perf_hooks";
import { MAX_RTP_PACKET_SIZE_IPV4, MAX_RTP_PACKET_SIZE_IPV6 } from "../protocol/constants.ts";
import type { StatisticsCollector } from "../stats/statistics-collector.ts";
import type { SessionEnvironment } from "../sender/sender-session.ts";

export type ReceivedPacketHandler = (arrivalTimeMs: number, packet: Buffer) => void;

export class UdpEnvironment implements SessionEnvironment {
  readonly maxPacketSize: number;
  private readonly socket: Socket;
  private remote: { address: string; port: number } | undefined;
  private handler: ReceivedPacketHandler | undefined;
  private closed = false;
  /** Called on a socket error that makes the stream unusable (`Environment::OnError`). */
  onSocketError: ((error: Error) => void) | undefined;
  /** `Environment::SetStatisticsCollector`: set by the session while statistics are on. */
  statisticsCollector: StatisticsCollector | undefined;

  /** `receiverAddress` decides the packet size: the receiver's address family is the path MTU assumption. */
  constructor(receiverAddress: string, socket?: Socket) {
    const v6 = isIPv6(receiverAddress);
    this.maxPacketSize = v6 ? MAX_RTP_PACKET_SIZE_IPV6 : MAX_RTP_PACKET_SIZE_IPV4;
    this.socket = socket ?? createSocket(v6 ? "udp6" : "udp4");
    this.socket.on("message", (msg, rinfo) => {
      const arrival = this.now();
      const remote = this.remote;
      // Packets from anywhere but the announced endpoint are ignored.
      if (remote === undefined || rinfo.address !== remote.address || rinfo.port !== remote.port) return;
      this.handler?.(arrival, msg);
    });
    this.socket.on("error", (error) => {
      if (!this.closed) this.onSocketError?.(error);
    });
  }

  /** Bind to an ephemeral port on the wildcard address (`IPEndpoint::kAnyV4`). Returns the bound port. */
  bind(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.socket.once("error", reject);
      this.socket.bind(0, () => {
        this.socket.off("error", reject);
        resolve(this.socket.address().port);
      });
    });
  }

  /** `Environment::ConsumeIncomingPackets`. */
  consumeIncomingPackets(handler: ReceivedPacketHandler): void {
    this.handler = handler;
  }

  /** `Environment::DropIncomingPackets`. */
  dropIncomingPackets(): void {
    this.handler = undefined;
  }

  now(): number {
    return performance.now();
  }

  setRemoteEndpoint(address: string, port: number): void {
    if (!(port > 0 && port <= 65535)) throw new RangeError("invalid remote port");
    this.remote = { address, port };
  }

  /** `SendPacket`. */
  sendPacket(packet: Buffer): void {
    const remote = this.remote;
    if (remote === undefined || this.closed) return;
    this.socket.send(packet, remote.port, remote.address);
  }

  schedule(atMs: number, cb: () => void): () => void {
    const timer = setTimeout(cb, Math.max(0, atMs - this.now()));
    return () => clearTimeout(timer);
  }

  /** `SetReceiveBufferSize` / `SetSendBufferSize`. */
  setBufferSizes(receive?: number, send?: number): void {
    if (receive !== undefined) this.socket.setRecvBufferSize(receive);
    if (send !== undefined) this.socket.setSendBufferSize(send);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.close();
  }
}
