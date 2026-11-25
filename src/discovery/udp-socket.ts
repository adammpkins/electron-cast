import dgram from "node:dgram";
import type { MdnsSocket, MdnsSocketHandlers, NetworkInterfaceInfo } from "./cast-discovery.ts";

export const MDNS_GROUP = "224.0.0.251";
export const MDNS_GROUP_V6 = "ff02::fb";
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
  group: string,
): MdnsSocket & { mode: "multicast" | "unicast" } {
  let closed = false;
  return {
    mode,
    send(packet: Buffer): void {
      socket.send(packet, MDNS_PORT, group, (error) => {
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
  return makeSocket(socket, handlers, "multicast", MDNS_GROUP);
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
  return makeSocket(socket, handlers, "unicast", MDNS_GROUP);
}

/** An IPv6 interface address with its zone, e.g. `fe80::1%12`: link-local addresses are ambiguous without one. */
function scoped(iface: NetworkInterfaceInfo): string {
  return iface.scopeId === undefined ? iface.address : `${iface.address}%${iface.scopeId}`;
}

async function setupMulticast6(
  create: CreateSocket,
  iface: NetworkInterfaceInfo,
  handlers: MdnsSocketHandlers,
): Promise<MdnsSocket & { mode: "multicast" | "unicast" }> {
  const socket = create({ type: "udp6", reuseAddr: true, ipv6Only: true });
  try {
    await waitForBind(socket, { port: MDNS_PORT, exclusive: false });
    socket.addMembership(MDNS_GROUP_V6, scoped(iface));
    socket.setMulticastInterface(`::%${iface.scopeId ?? iface.name}`);
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
  return makeSocket(socket, handlers, "multicast", MDNS_GROUP_V6);
}

async function setupUnicast6(
  create: CreateSocket,
  iface: NetworkInterfaceInfo,
  handlers: MdnsSocketHandlers,
): Promise<MdnsSocket & { mode: "multicast" | "unicast" }> {
  const socket = create({ type: "udp6", ipv6Only: true });
  try {
    await waitForBind(socket, { port: 0, address: scoped(iface) });
    socket.setMulticastInterface(`::%${iface.scopeId ?? iface.name}`);
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
  return makeSocket(socket, handlers, "unicast", MDNS_GROUP_V6);
}

/**
 * Opens an mDNS socket on one interface: multicast on port 5353 if possible, else a unicast socket. An IPv6
 * interface (`family: "IPv6"`) uses ff02::fb on that interface's scope.
 */
export function openUdpMdnsSocket(
  iface: NetworkInterfaceInfo,
  handlers: MdnsSocketHandlers,
  options?: { createSocket?: CreateSocket },
): Promise<MdnsSocket & { mode: "multicast" | "unicast" }> {
  const create = options?.createSocket ?? ((opts: dgram.SocketOptions) => dgram.createSocket(opts));
  if (iface.family === "IPv6") {
    return setupMulticast6(create, iface, handlers).catch(() => setupUnicast6(create, iface, handlers));
  }
  return setupMulticast(create, iface, handlers).catch(() => setupUnicast(create, iface, handlers));
}
