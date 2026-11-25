// A sandboxed preload cannot import files or ESM, so (like any app that uses electron-cast) bundle it to one CJS file.
// Bundling the built package entry `electron-cast/preload` also proves it pulls in nothing Node-only.
// The mirroring scenarios' fake receiver is TypeScript, which the Node of older Electrons (35) cannot load, so it is
// bundled to plain JavaScript as well.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

for (const mode of ["presentation", "chromecast"]) {
  await build({
    stdin: {
      contents: `
        import { contextBridge, ipcRenderer } from "electron";
        import { installCastBridge } from "electron-cast/preload";
        // Reported to the main process so the test can tell that the preload really ran sandboxed.
        ipcRenderer.send("smoke:preload", { mode: ${JSON.stringify(mode)}, sandboxed: process.sandboxed === true });
        installCastBridge({ contextBridge, ipcRenderer, mode: ${JSON.stringify(mode)} });
      `,
      resolveDir: root,
      sourcefile: `preload-${mode}.js`,
    },
    outfile: fileURLToPath(new URL(`.out/preload-${mode}.cjs`, import.meta.url)),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    external: ["electron"],
    logLevel: "warning",
  });
}

await build({
  entryPoints: [fileURLToPath(new URL("../test/mirroring/fake-receiver.ts", import.meta.url))],
  outfile: fileURLToPath(new URL(".out/fake-receiver.mjs", import.meta.url)),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  logLevel: "warning",
});
