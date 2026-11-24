/** Live developer tool: `node examples/discover.ts [seconds]` listens for Cast devices and prints them. */
import { CastDiscovery } from "../src/discovery/index.ts";
import type { CastDevice } from "../src/discovery/index.ts";

const arg = process.argv[2];
const seconds = arg !== undefined && Number.isFinite(Number(arg)) && Number(arg) > 0 ? Number(arg) : 10;

const discovery = new CastDiscovery();

const line = (kind: string, d: CastDevice): void => {
  console.log(`${kind.padEnd(6)} ${d.name}  ${d.model}  ${d.host}:${d.port}  ca=${d.capabilities}  id=${d.id}`);
};

discovery.on("deviceUp", (d) => line("up", d));
discovery.on("deviceChanged", (d) => line("changed", d));
discovery.on("deviceDown", (d) => line("down", d));
discovery.on("socketError", (iface, error) => {
  console.log(`socket error on ${iface.name} (${iface.address}): ${error.message}`);
});

await discovery.start();
for (const iface of discovery.interfaces()) {
  console.log(`listening on ${iface.name} (${iface.address})`);
}

setTimeout(() => {
  const count = discovery.devices().length;
  discovery.stop();
  console.log(`done: ${count} device(s)`);
}, seconds * 1000);
