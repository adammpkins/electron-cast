import dgram from "node:dgram";
import type { MdnsSocket, MdnsSocketHandlers, NetworkInterfaceInfo } from "./cast-discovery.ts";

export const MDNS_GROUP = "224.0.0.251";
export const MDNS_PORT = 5353;

type CreateSocket = (options: dgram.SocketOptions) => dgram.Socket;

/** Resolves when the socket is bound; rejects on the "error" event that arrives before the callback. */
function waitForBind(socket: dgram.Socket, options: dgram.BindOptions): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const onError = (error: Error): void => {
      if (settled) return;
      settled = true;
      socket.removeListener("error", onError);
      reject(error);
    };
    const onBound = (): void => {
      if (settled) return;
      settled = true;
      socket.removeListener("error", onError);
      resolve();
    };
    socket.once("error", onError);
    socket.bind(options, onBound);
  });
}

/** Wires a fully set-up socket to the handlers. */
function attach(socket: dgram.Socket, handlers: MdnsSocketHandlers): void {
  socket.on("message", (msg: Buffer, rinfo: dgram.RemoteInfo) => {
    handlers.message(msg, { address: rinfo.address, port: rinfo.port });
  });
  socket.on("error", (error: Error) => {
    handlers.error(error);
  });
}

/** Wraps a set-up dgram socket; `close` closes it at most once. */
function makeSocket(
  socket: dgram.Socket,
  handlers: MdnsSocketHandlers,
  mode: "multicast" | "unicast",
): MdnsSocket & { mode: "multicast" | "unicast" } {
  let closed = false;
  return {
    mode,
    send(packet: Buffer): void {
      socket.send(packet, MDNS_PORT, MDNS_GROUP, (error) => {
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
  };
}

async function setupMulticast(
  create: CreateSocket,
  iface: NetworkInterfaceInfo,
  handlers: MdnsSocketHandlers,
): Promise<MdnsSocket & { mode: "multicast" | "unicast" }> {
  const socket = create({ type: "udp4", reuseAddr: true });
  try {
    await waitForBind(socket, { port: MDNS_PORT, exclusive: false });
    socket.addMembership(MDNS_GROUP, iface.address);
    socket.setMulticastInterface(iface.address);
    socket.setMulticastTTL(255);
    socket.setMulticastLoopback(false);
  } catch (error) {
    try {
      socket.close();
    } catch {
      // already closed
    }
    throw error;
  }
  attach(socket, handlers);
  return makeSocket(socket, handlers, "multicast");
}

/** mDNS legacy unicast: bind an ephemeral port on the interface; responders answer straight back. */
async function setupUnicast(
  create: CreateSocket,
  iface: NetworkInterfaceInfo,
  handlers: MdnsSocketHandlers,
): Promise<MdnsSocket & { mode: "multicast" | "unicast" }> {
  const socket = create({ type: "udp4" });
  try {
    await waitForBind(socket, { port: 0, address: iface.address });
    socket.setMulticastInterface(iface.address);
    socket.setMulticastTTL(255);
  } catch (error) {
    try {
      socket.close();
    } catch {
      // already closed
    }
    throw error;
  }
  attach(socket, handlers);
  return makeSocket(socket, handlers, "unicast");
}

/** Opens an mDNS socket on one interface: multicast on port 5353 if possible, else a unicast socket. */
export function openUdpMdnsSocket(
  iface: NetworkInterfaceInfo,
  handlers: MdnsSocketHandlers,
  options?: { createSocket?: CreateSocket },
): Promise<MdnsSocket & { mode: "multicast" | "unicast" }> {
  const create = options?.createSocket ?? ((opts: dgram.SocketOptions) => dgram.createSocket(opts));
  return setupMulticast(create, iface, handlers).catch(() => setupUnicast(create, iface, handlers));
}
