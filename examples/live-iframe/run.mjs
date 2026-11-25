// `npm run live:iframe`: installs Electron on first use (the same way the smoke test does), builds the package and the
// preload, and starts the live iframe harness. It needs a display and a person; see README.md. It never casts by itself.
// Pass --selftest to run the no-click check (loads both iframes, reports the SDK state, then quits).
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../..", import.meta.url));
const here = (name) => fileURLToPath(new URL(name, import.meta.url));
const electronDir = fileURLToPath(new URL("../../smoke/.out/electron/", import.meta.url));

const run = (command) => {
  const r = spawnSync(command, { cwd: root, stdio: "inherit", shell: true });
  if (r.status !== 0) {
    console.error(`live-iframe: "${command}" failed`);
    process.exit(1);
  }
};

if (!existsSync(`${electronDir}node_modules/electron/package.json`)) {
  console.log("live-iframe: installing Electron 45 into smoke/.out/electron");
  run("npm i --prefix smoke/.out/electron --no-package-lock electron@45");
}
// Electron 45+ has no postinstall and downloads its binary on first use; fetch it now (a no-op when it is there)
run("node smoke/.out/electron/node_modules/electron/install.js");
const electron = createRequire(`${electronDir}package.json`)("electron");
if (typeof electron !== "string") {
  console.error("live-iframe: could not resolve the electron binary");
  process.exit(1);
}

console.log("live-iframe: building electron-cast");
run("npm run build");

// A sandboxed preload can load no packages, so bundle it to one CJS file, as the smoke test does
await build({
  entryPoints: [here("preload.js")],
  outfile: here(".out/preload.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  external: ["electron"],
  logLevel: "warning",
});

// Even an empty value makes Electron run as plain Node, so remove it rather than blank it
const { ELECTRON_RUN_AS_NODE: _unused, ...env } = process.env;
const child = spawn(electron, [here("main.mjs"), ...process.argv.slice(2)], { cwd: root, stdio: "inherit", env });
child.on("exit", (code) => process.exit(code ?? 1));
