#!/usr/bin/env node
// Read-only connection probe over IPv6. Discovers devices (mDNS only), then for each device that announced IPv6
// addresses opens electron-cast's CastClient to each of them in turn (ULA, global, link-local with its %scope):
// TLS, device authentication and one GET_STATUS, then closes. It sends no launch, stop, volume or media command.
// (CastClient's connect also sends the protocol's own CONNECT to the platform receiver, and CLOSE on close.)
//
// Usage: node tools/probe-connect.mjs [--seconds 8] [--names] [--ipv4]
//   --ipv4  also try each device's IPv4 address, for comparison
import { CastClient, CastDiscovery } from "../src/index.ts";

const args = process.argv.slice(2);
const secondsAt = args.indexOf("--seconds");
const seconds = secondsAt >= 0 && Number(args[secondsAt + 1]) > 0 ? Number(args[secondsAt + 1]) : 8;
const showNames = args.includes("--names");
const withV4 = args.includes("--ipv4");

const kindOf = (a) => {
  if (!a.includes(":")) return "IPv4";
  if (/^fe[89ab][0-9a-f]:/i.test(a)) return a.includes("%") ? "link-local+scope" : "link-local (no scope)";
  if (/^f[cd]/i.test(a)) return "ULA";
  return "global";
};

const discovery = new CastDiscovery();
await discovery.start();
await new Promise((r) => setTimeout(r, seconds * 1000));
const devices = discovery.devices();
discovery.stop();

console.log(`probe-connect: ${devices.length} devices; per address: TLS + device auth + GET_STATUS, then close (no other command)`);
const rows = [];
let n = 0;
for (const d of devices) {
  n++;
  const addrs = d.addresses.filter((a) => (withV4 ? true : a.includes(":")));
  if (!addrs.some((a) => a.includes(":"))) continue;
  for (const address of addrs) {
    const client = new CastClient({ host: address, port: d.port, verifyDevice: true, connectTimeoutMs: 8000, authTimeoutMs: 8000, requestTimeoutMs: 8000 });
    const start = performance.now();
    const row = { device: showNames ? `${d.name}` : `device ${n}`, model: d.model, kind: kindOf(address), address: showNames ? address : "", result: "" };
    try {
      await client.connect();
      const auth = client.deviceAuth;
      await client.getStatus();
      const ms = Math.round(performance.now() - start);
      row.result = `PASS auth=${auth ? `${auth.policy}/${auth.hashAlgorithm}${auth.revocationChecked ? "" : " (revocation not checked)"}` : "none"} ${ms} ms`;
    } catch (error) {
      row.result = `FAIL ${error?.name ?? "Error"}: ${error?.message ?? error} (${Math.round(performance.now() - start)} ms)`;
    } finally {
      client.close();
    }
    rows.push(row);
    console.log(`${row.device.padEnd(10)} ${row.model.padEnd(20)} ${row.kind.padEnd(22)} ${row.result}`);
  }
}
const v6 = rows.filter((r) => r.kind !== "IPv4");
console.log(`done: ${v6.filter((r) => r.result.startsWith("PASS")).length}/${v6.length} IPv6 addresses passed`);
process.exit(0);
