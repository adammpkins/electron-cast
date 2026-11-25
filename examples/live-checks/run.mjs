// `npm run live:checks -- <check> [options]`: installs Electron on first use (as the smoke test does), builds the package and the
// sandboxed preload, then runs one live check in a real Electron. See README.md. Nothing here casts without --sink and --yes.
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../..", import.meta.url));
const here = (name) => fileURLToPath(new URL(name, import.meta.url));
const electronDir = fileURLToPath(new URL("../../smoke/.out/electron/", import.meta.url));
const [check, ...rest] = process.argv.slice(2);
const script = { "dial-dedup": "dial-dedup.mjs", cast: "cast.mjs" }[check];
if (script === undefined) {
  console.error("usage: npm run live:checks -- dial-dedup [--secs 60]\n       npm run live:checks -- cast --sink <device name> --test top|iframe-same|iframe-cross|sandbox-no-presentation|sandbox-presentation|default-presentation --yes [--secs 80]");
  process.exit(2);
}
const run = (command) => {
  const r = spawnSync(command, { cwd: root, stdio: "inherit", shell: true });
  if (r.status !== 0) { console.error(`live-checks: "${command}" failed`); process.exit(1); }
};
if (!existsSync(`${electronDir}node_modules/electron/package.json`)) run("npm i --prefix smoke/.out/electron --no-package-lock electron@45");
run("node smoke/.out/electron/node_modules/electron/install.js");
const electron = createRequire(`${electronDir}package.json`)("electron");
run("npm run build");
await build({ entryPoints: [here("preload.js")], outfile: here(".out/preload.cjs"), bundle: true, platform: "node", format: "cjs", target: "node20", external: ["electron"], logLevel: "warning" });
const { ELECTRON_RUN_AS_NODE: _unused, ...env } = process.env;
const child = spawn(electron, [here(script), ...rest], { cwd: root, stdio: "inherit", env });
child.on("exit", (code) => process.exit(code ?? 1));
