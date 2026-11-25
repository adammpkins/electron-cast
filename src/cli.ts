#!/usr/bin/env node
// The `electron-cast` command. Today it has one subcommand, `dial-test`; see dial-test/cli-main.ts.
import { readFileSync } from "node:fs";
import readline from "node:readline";
import { runCli } from "./dial-test/cli-main.ts";

function libraryVersion(): string {
  try {
    const text = readFileSync(new URL("../package.json", import.meta.url), "utf8");
    const version = (JSON.parse(text) as { version?: unknown }).version;
    return typeof version === "string" ? version : "unknown";
  } catch {
    return "unknown";
  }
}

const controller = new AbortController();
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
let closed = false;
let pending: ((answer: string | null) => void) | null = null;
rl.on("close", () => {
  closed = true;
  pending?.(null);
  pending = null;
});

// The first Ctrl-C asks the test to stop what it opened and finish; a second one leaves at once.
let interrupts = 0;
const interrupt = (): void => {
  if (++interrupts > 1) process.exit(130);
  console.log("\nStopping (press Ctrl-C again to leave at once)...");
  controller.abort();
};
rl.on("SIGINT", interrupt);
process.on("SIGINT", interrupt);

const code = await runCli({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  libraryVersion: libraryVersion(),
  out: (line) => console.log(line),
  err: (line) => console.error(line),
  signal: controller.signal,
  ask: (question) => new Promise<string | null>((resolve) => {
    if (closed) {
      resolve(null);
      return;
    }
    pending = resolve;
    rl.question(`${question} `, (answer) => {
      pending = null;
      resolve(answer);
    });
  }),
});
rl.close();
process.exitCode = code;
