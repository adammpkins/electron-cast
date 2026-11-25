// Builds the preloads and runs smoke/main.mjs in a real Electron. Install the Electron to test into its own folder:
//   npm i --prefix smoke/.out/electron --no-package-lock electron@<version>
// (Installing it into the repo's own node_modules does nothing: electron is an optional peer dependency, so npm skips it.)
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const INSTALL = "npm i --prefix smoke/.out/electron --no-package-lock electron@<version>";
let electron;
let version = "?";
for (const from of [new URL(".out/electron/package.json", import.meta.url), import.meta.url]) {
  try {
    const req = createRequire(from);
    electron = req("electron");
    version = req("electron/package.json").version;
    break;
  } catch {
    // try the next place
  }
}
if (electron === undefined) {
  console.error(`smoke: electron is not installed. Run: ${INSTALL}`);
  process.exit(1);
}
console.log(`smoke: Electron ${version}`);
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
