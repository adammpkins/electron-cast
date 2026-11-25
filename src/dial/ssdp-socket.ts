// The UDP side of DIAL discovery: one unicast socket per IPv4 interface that sends the M-SEARCH to the SSDP group and
// hears the unicast answers, as DialServiceImpl::DialSocket does (chrome/browser/media/router/discovery/dial/dial_service_impl.cc).
import dgram from "node:dgram";
import type { NetworkInterfaceInfo } from "../discovery/cast-discovery.ts";

export const SSDP_GROUP = "239.255.255.250";
export const SSDP_PORT = 1900;

/** Callbacks for an SSDP socket: incoming packets and socket errors. */
export interface SsdpSocketHandlers {
  message(packet: Buffer, from: { address: string; port: number }): void;
  error(error: Error): void;
}

/** An open SSDP socket: send the search on it, close it when the cycle ends. */
export interface SsdpSocket { send(packet: Buffer): void; close(): void }

/** Opens an SSDP socket on one interface; rejects if it cannot. */
export type OpenSsdpSocket = (iface: NetworkInterfaceInfo, handlers: SsdpSocketHandlers) => Promise<SsdpSocket>;

type CreateSocket = (options: dgram.SocketOptions) => dgram.Socket;

/**
 * `options.target` replaces the SSDP group, for tests that answer on a local address.
 * Binds an ephemeral port on the interface's address (`CreateAndBindSocket`: `RANDOM_BIND`, port 0, broadcast on).
 * Answers come back unicast to that port, so the socket never joins the SSDP group. It also pins multicast sends to the
 * interface (Chromium relies on the bound address; Windows needs the explicit setting to leave by the right adapter).
 */
export function openUdpSsdpSocket(
  iface: NetworkInterfaceInfo,
  handlers: SsdpSocketHandlers,
  options?: { createSocket?: CreateSocket; target?: { address: string; port: number } },
): Promise<SsdpSocket> {
  const create = options?.createSocket ?? ((opts: dgram.SocketOptions) => dgram.createSocket(opts));
  const socket = create({ type: "udp4" });
  return new Promise<SsdpSocket>((resolve, reject) => {
    const onBindError = (error: Error): void => {
      try {
        socket.close();
      } catch {
        // already closed
      }
      reject(error);
    };
    socket.once("error", onBindError);
    socket.bind({ port: 0, address: iface.address }, () => {
      socket.removeListener("error", onBindError);
      try {
        socket.setBroadcast(true);
        socket.setMulticastInterface(iface.address);
      } catch (error) {
        onBindError(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      socket.on("message", (msg: Buffer, rinfo: dgram.RemoteInfo) => {
        handlers.message(msg, { address: rinfo.address, port: rinfo.port });
      });
      socket.on("error", (error: Error) => handlers.error(error));
      let closed = false;
      resolve({
        send(packet: Buffer): void {
          if (closed) return;
          socket.send(packet, options?.target?.port ?? SSDP_PORT, options?.target?.address ?? SSDP_GROUP, (error) => {
            if (error) handlers.error(error);
          });
        },
        close(): void {
          if (closed) return;
          closed = true;
          try {
            socket.close();
          } catch {
            // already closed
          }
        },
      });
    });
  });
}
