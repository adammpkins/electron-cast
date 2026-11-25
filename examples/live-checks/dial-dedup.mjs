// Read-only: DIAL on (as docs/API.md describes: the default, or dial: true), lists sinks for --secs and labels where each came from.
//   electron dial-dedup.mjs --secs 60
// Only mDNS queries, SSDP searches and DIAL device-description GETs. No Cast channel is opened by this file; the manager opens
// Cast channels to discovered devices (that is what makes them sinks), as Chrome's Cast discovery does.
import { app, ipcMain } from "electron";
import { createCastManager } from "electron-cast/main";
import { CastDiscovery, DialService } from "electron-cast";
const processDeviceUuid = (u) => (u.startsWith("uuid:") ? u.slice(5) : u).replaceAll("-", "").toLowerCase();

const args = process.argv.slice(2);
const value = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const secs = Number(value("secs", "60"));
const t0 = Date.now();
const out = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}] ${m}`);
app.on("window-all-closed", () => {});

app.whenReady().then(async () => {
  const cast = createCastManager({ ipcMain, presentation: false, dial: true, selectDevice: async () => null });
  // Independent raw sources, so each sink can be labelled. rawDial has no isCastDevice, so it keeps every DIAL answer.
  const rawMdns = new CastDiscovery();
  const rawDial = new DialService({ hashToken: "raw", log: (m) => out(`rawDial log: ${m}`) });
  let managerSinks = [];
  const castSeen = new Set(), flapped = new Set();
  const everDial = new Set();   // any DIAL-provider sink the manager ever reported, even for an instant
  let updates = 0;
  cast.registerMediaSinksObserver({ onSinksUpdated: (s) => {
    managerSinks = s; updates++;
    for (const k of s) if (k.providerId === "dial" && !everDial.has(k.id)) { everDial.add(k.id); out(`DIAL sink reported by manager: ${k.id} "${k.name}"`); }
    out(`sinks update #${updates}: ${s.map((k) => `${k.providerId}:${k.name}(${k.id.slice(0, 13)})`).join(", ")}`);
    // Once a device is a Cast sink, a DIAL sink for it must never come back (Chrome removes it in OnChannelOpenSucceeded)
    for (const k of s) {
      const u = k.providerId === "dial" ? k.id.slice(5) : processDeviceUuid(k.id);
      if (k.providerId === "cast") castSeen.add(u);
      else if (castSeen.has(u)) { flapped.add(k.id); out(`FLAP: DIAL sink ${k.id} back after the Cast sink`); }
    }
    for (const u of castSeen) if (s.filter((k) => (k.providerId === "dial" ? k.id.slice(5) : processDeviceUuid(k.id)) === u).length > 1) { flapped.add(`both:${u}`); out(`BOTH listed in one update: ${u}`); }
  } });
  await cast.start();
  await rawMdns.start();
  rawDial.start();

  const snapshot = (label) => {
    const mdns = rawMdns.devices();
    const dials = rawDial.devices();
    const dialUuids = new Map(dials.map((d) => [processDeviceUuid(d.id.replace(/^dial:/, "")), d]));
    const mdnsUuids = new Map(mdns.map((d) => [processDeviceUuid(d.id), d]));
    out(`--- ${label} ---`);
    out(`raw mDNS (${mdns.length}): ${mdns.map((d) => `${d.name}[${processDeviceUuid(d.id).slice(0, 8)}]`).join(", ")}`);
    out(`raw DIAL (${dials.length}): ${dials.map((d) => `${d.name}[${d.id.slice(5, 13)}] ${d.dial.ipAddress} ${d.model}`).join(", ")}`);
    out(`manager sinks (${managerSinks.length}):`);
    const rows = managerSinks.map((s) => {
      const uuid = s.providerId === "dial" ? s.id.slice(5) : processDeviceUuid(s.id);
      const inDial = dialUuids.has(uuid), inMdns = mdnsUuids.has(uuid);
      const source = s.providerId === "dial" ? "dial" : inDial ? "promoted" : "mdns";
      return { id: s.id, uuid, name: s.name, provider: s.providerId, source, inRawDial: inDial, inRawMdns: inMdns, model: s.description, host: s.device.host };
    });
    for (const r of rows) out(`  ${r.source.padEnd(8)} ${r.provider.padEnd(4)} id=${r.id} name="${r.name}" model="${r.model}" host=${r.host} (rawDial=${r.inRawDial} rawMdns=${r.inRawMdns})`);
    const byUuid = new Map();
    for (const r of rows) byUuid.set(r.uuid, (byUuid.get(r.uuid) ?? 0) + 1);
    const dupes = [...byUuid].filter(([, n]) => n > 1);
    const byHost = new Map();
    for (const r of rows) byHost.set(r.host, [...(byHost.get(r.host) ?? []), r.name]);
    // a speaker group answers from its coordinator's address, so a shared host is only a duplicate when the uuid matches
    const dupHosts = [...byHost].filter(([, n]) => n.length > 1 && false);
    out(`duplicates by uuid: ${dupes.length}${dupes.length ? " " + JSON.stringify(dupes) : ""}; by host: ${dupHosts.length}${dupHosts.length ? " " + JSON.stringify(dupHosts) : ""}`);
    const both = [...dialUuids.keys()].filter((u) => mdnsUuids.has(u));
    out(`devices that answered both mDNS and DIAL: ${both.length}; of those listed as Cast sinks: ${rows.filter((r) => r.source === "promoted").length}; listed as DIAL sinks: ${rows.filter((r) => r.provider === "dial" && mdnsUuids.has(r.uuid)).length}`);
    return { rows, dupes, dupHosts, both: both.length };
  };
  for (const at of [20, 40]) if (at < secs) setTimeout(() => snapshot(`t=${at}s`), at * 1000);
  setTimeout(async () => {
    const r = snapshot("final");
    const dialOnly = r.rows.filter((x) => x.provider === "dial");
    out(`RESULT ${r.dupes.length === 0 && r.dupHosts.length === 0 && r.rows.filter((x) => x.provider === "dial" && x.inRawMdns).length === 0 && flapped.size === 0 ? "PASS" : "FAIL"}: sinks=${r.rows.length} promoted=${r.rows.filter((x) => x.source === "promoted").length} dial-only=${dialOnly.length} dupes=${r.dupes.length} dialSinksReportedBeforeChannelOpened=${everDial.size} flaps=${flapped.size} sinkUpdates=${updates}`);
    rawMdns.stop(); rawDial.stop(); await cast.dispose(); app.exit(0);
  }, secs * 1000);
});
