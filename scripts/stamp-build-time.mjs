// Writes the build time into the compiled dist files: the library's stand-in for Chromium's base::GetBuildTime(), which
// starts the built-in fallback CRL's 20-week window. SOURCE_DATE_EPOCH (seconds) is honoured for reproducible builds.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PATTERN = /(\bBUILD_TIME = )undefined;/;
const TARGETS = ["../dist/client/auth/build-time.js", "../dist/cjs/client/auth/build-time.js"];

/** Replaces `BUILD_TIME = undefined` in the file at `path`; throws if the build output no longer has it. */
export function stampFile(path, timeMs) {
  const text = readFileSync(path, "utf8");
  if (!PATTERN.test(text)) throw new Error(`${path}: no "BUILD_TIME = undefined" to stamp`);
  writeFileSync(path, text.replace(PATTERN, `$1${timeMs};`));
}

export function buildTimeMs(env = process.env) {
  const epoch = env.SOURCE_DATE_EPOCH;
  if (epoch !== undefined && epoch !== "") {
    if (!/^\d+$/.test(epoch)) throw new Error("SOURCE_DATE_EPOCH must be whole seconds");
    return Number(epoch) * 1000;
  }
  return Date.now();
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const time = buildTimeMs();
  for (const target of TARGETS) stampFile(fileURLToPath(new URL(target, import.meta.url)), time);
}
