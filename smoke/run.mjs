// Builds the preloads and runs smoke/main.mjs in a real Electron (installed separately: npm i --no-save electron@<n>).
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
let electron;
try {
  electron = createRequire(import.meta.url)("electron");
} catch {
  console.error("smoke: electron is not installed. Run: npm i --no-save electron@<version>");
  process.exit(1);
}
if (typeof electron !== "string") {
  console.error("smoke: could not resolve the electron binary");
  process.exit(1);
}

await import("./build-preloads.mjs");

// Even an empty value makes Electron run as plain Node, so remove it rather than blank it
const { ELECTRON_RUN_AS_NODE: _unused, ...env } = process.env;
const child = spawn(electron, [fileURLToPath(new URL("main.mjs", import.meta.url))], { cwd: root, stdio: "inherit", env });
// Backstop for a hang before main.mjs arms its own timeout
const killer = setTimeout(() => {
  console.error("smoke: FAIL electron did not exit within 90 s");
  child.kill();
}, 90_000);
child.on("exit", (code, signal) => {
  clearTimeout(killer);
  if (code === null) console.error(`smoke: FAIL electron was killed by ${signal}`);
  process.exit(code ?? 1);
});
