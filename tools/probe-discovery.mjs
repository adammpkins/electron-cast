#!/usr/bin/env node
// Read-only discovery probe: runs electron-cast's real CastDiscovery for a while and reports, per network
// interface, which address family each Cast device answered on and which addresses it announced, then which
// address electron-cast would connect to. It only listens for and sends mDNS queries (PTR _googlecast._tcp). It
// never opens a Cast (TLS 8009) connection.
//
// Usage: node tools/probe-discovery.mjs [--seconds 15] [--names] [--json]
//   --names  print device names and ids (hidden by default so the output can be shared)
//   --json   print the result as JSON instead of text
import { CastDiscovery, decodeDnsPacket, listMdnsInterfaces, openUdpMdnsSocket } from "../src/discovery/index.ts";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const secondsAt = args.indexOf("--seconds");
const seconds = secondsAt >= 0 && Number(args[secondsAt + 1]) > 0 ? Number(args[secondsAt + 1]) : 15;
const showNames = flag("--names");

const familyOf = (address) => (address.includes(":") ? "IPv6" : "IPv4");
const ifaceLabel = (i) => `${i.name} ${i.family === "IPv6" ? `IPv6 ${i.address}%${i.scopeId}` : `IPv4 ${i.address}`}`;

/** heard[ifaceLabel] = { socketFamily, mode, instances: Map<instance, { hosts:Set, packets:number }>, hostAddrs: Map<host, Set> } */
const heard = new Map();
const errors = [];

const discovery = new CastDiscovery({
  openSocket: async (iface, handlers) => {
    const label = ifaceLabel(iface);
    const entry = { iface, socketFamily: iface.family ?? "IPv4", mode: "?", instances: new Map(), hostAddrs: new Map() };
    heard.set(label, entry);
    const socket = await openUdpMdnsSocket(iface, {
      error: handlers.error,
      message: (packet, from) => {
        try {
          const decoded = decodeDnsPacket(packet);
          if (decoded.isResponse) {
            const records = [...decoded.answers, ...decoded.authorities, ...decoded.additionals];
            for (const r of records) {
              const instance = r.type === "PTR" ? r.data : r.type === "SRV" || r.type === "TXT" ? r.name : undefined;
              if (instance === undefined || !instance.toLowerCase().includes("._googlecast._tcp")) continue;
              const inst = entry.instances.get(instance.toLowerCase()) ?? { hosts: new Set(), packets: 0 };
              if (r.type === "SRV") inst.hosts.add(r.data.target.toLowerCase());
              inst.packets++;
              entry.instances.set(instance.toLowerCase(), inst);
            }
            for (const r of records) {
              if (r.type !== "A" && r.type !== "AAAA") continue;
              const set = entry.hostAddrs.get(r.name.toLowerCase()) ?? new Set();
              set.add(r.data);
              entry.hostAddrs.set(r.name.toLowerCase(), set);
            }
            entry.lastFrom = from.address;
          }
        } catch {
          // not DNS
        }
        handlers.message(packet, from);
      },
    });
    entry.mode = socket.mode;
    return socket;
  },
});
discovery.on("socketError", (iface, error) => errors.push(`${ifaceLabel(iface)}: ${error.message}`));

const planned = listMdnsInterfaces();
await discovery.start();
await new Promise((resolve) => setTimeout(resolve, seconds * 1000));

const devices = discovery.devices();
const open = discovery.interfaces().map(ifaceLabel);
discovery.stop();

const result = { seconds, interfacesPlanned: planned.map(ifaceLabel), interfacesOpen: open, errors, devices: [] };
devices.forEach((d, index) => {
  const instance = d.instanceName.toLowerCase();
  const perIface = [];
  for (const [label, entry] of heard) {
    const inst = entry.instances.get(instance);
    if (inst === undefined) continue;
    const addrs = new Set();
    for (const host of inst.hosts) for (const a of entry.hostAddrs.get(host) ?? []) addrs.add(a);
    perIface.push({
      interface: label,
      answeredOver: entry.socketFamily,
      socket: entry.mode,
      announced: [...addrs].map((a) => (/^fe[89ab]/i.test(a) && !a.includes("%") && entry.iface.scopeId ? `${a}%${entry.iface.scopeId}` : a)),
    });
  }
  const transports = new Set(perIface.map((p) => p.answeredOver));
  const hasA = d.addresses.some((a) => familyOf(a) === "IPv4");
  result.devices.push({
    label: showNames ? `${d.name} (${d.id})` : `device ${index + 1}`,
    model: d.model,
    host: d.host,
    hostFamily: familyOf(d.host),
    addresses: d.addresses,
    perInterface: perIface,
    answeredOnlyOverIPv6: transports.size > 0 && !transports.has("IPv4"),
    hasIPv4Address: hasA,
  });
});
result.anyIPv6OnlyAnswer = result.devices.some((d) => d.answeredOnlyOverIPv6);
result.anyHostIsIPv6 = result.devices.some((d) => d.hostFamily === "IPv6");

if (flag("--json")) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`probe: ${seconds} s, read-only (mDNS queries only, no Cast connections)`);
  console.log(`interfaces planned: ${result.interfacesPlanned.length}`);
  for (const i of result.interfacesPlanned) console.log(`  ${i}${open.includes(i) ? "" : "   (no socket opened)"}`);
  for (const e of errors) console.log(`  socket error: ${e}`);
  console.log(`devices found: ${result.devices.length}`);
  for (const d of result.devices) {
    console.log(`- ${d.label}  model=${d.model}`);
    for (const p of d.perInterface) {
      console.log(`    ${p.interface}: answered over ${p.answeredOver} (${p.socket} socket); announced ${p.announced.join(", ") || "no addresses"}`);
    }
    console.log(`    electron-cast connects to: ${d.host} (${d.hostFamily}); all: ${d.addresses.join(", ")}`);
    if (d.answeredOnlyOverIPv6) console.log("    ** answered ONLY over IPv6 **");
  }
  console.log(`any device answered only over IPv6: ${result.anyIPv6OnlyAnswer ? "yes" : "no"}`);
  console.log(`any device would be connected to over IPv6: ${result.anyHostIsIPv6 ? "yes" : "no"}`);
}
process.exit(0);
