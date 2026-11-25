// The `dial-test` command: argument parsing, and the report's three outputs (the terminal, a file and an issue link).
import { writeFileSync } from "node:fs";
import path from "node:path";
import { buildIssueUrl } from "./report.ts";
import { runDialTest, type DialTestOptions } from "./runner.ts";

export const USAGE = `Usage: electron-cast dial-test [options]

Checks how a DIAL TV (Roku, Samsung, LG, Sony, Fire TV and others that offer DIAL but not Chromecast) behaves with
electron-cast, and writes a report you can post as a GitHub issue. It needs only Node, not Electron.

What it does:
  1. Looks for DIAL devices for about 10 seconds, on every network interface, the way Chrome does.
  2. Reads the device description and the app info of YouTube and Netflix. It changes nothing.
  3. Opens one TLS connection to port 8009 and closes it at once (no Cast message is sent).
  4. Asks whether to open YouTube on the TV. Only if you say yes, it opens YouTube, asks you what you saw, and
     closes it again.
  5. Prints a report with names, serial numbers, UUIDs, MAC addresses, IP addresses and URL hosts removed, saves it
     as dial-test-report.md in the current folder, and prints a link that opens a prefilled GitHub issue.

Read the report before you post it.

Options:
  --device N        Test the Nth device of the list without asking.
  --yes             Answer yes to opening YouTube and do not ask the other questions (for scripts).
  --read-only       Never open anything; skip the question about YouTube.
  --seconds N       How long to search (default 10).
  --out FILE        Where to write the report (default dial-test-report.md).
  -h, --help        This help.
`;

export interface CliEnv {
  argv: string[];
  cwd: string;
  libraryVersion: string;
  /** Normal output: one line per call. */
  out(line: string): void;
  err(line: string): void;
  ask(question: string): Promise<string | null>;
  signal?: AbortSignal;
  /** For tests: replaces the discovery and timing options. */
  overrides?: Partial<DialTestOptions>;
  writeFile?: (file: string, text: string) => void;
}

interface Parsed {
  help: boolean;
  deviceIndex?: number;
  yes: boolean;
  readOnly: boolean;
  seconds?: number;
  out: string;
}

function parseArgs(args: string[]): Parsed | string {
  const parsed: Parsed = { help: false, yes: false, readOnly: false, out: "dial-test-report.md" };
  const number = (name: string, value: string | undefined): number | string => {
    const n = Number(value);
    return value !== undefined && Number.isInteger(n) && n >= 1 ? n : `${name} needs a whole number of 1 or more`;
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    const inline = eq === -1 ? undefined : arg.slice(eq + 1);
    const value = (): string | undefined => inline ?? args[++i];
    switch (flag) {
      case "-h": case "--help": parsed.help = true; break;
      case "--yes": case "-y": parsed.yes = true; break;
      case "--read-only": parsed.readOnly = true; break;
      case "--device": {
        const n = number("--device", value());
        if (typeof n === "string") return n;
        parsed.deviceIndex = n;
        break;
      }
      case "--seconds": {
        const n = number("--seconds", value());
        if (typeof n === "string") return n;
        parsed.seconds = n;
        break;
      }
      case "--out": {
        const file = value();
        if (file === undefined || file === "") return "--out needs a file name";
        parsed.out = file;
        break;
      }
      default: return `unknown option ${arg}`;
    }
  }
  return parsed;
}

/** Runs `electron-cast <command> ...`; returns the process exit code. */
export async function runCli(env: CliEnv): Promise<number> {
  const [command, ...rest] = env.argv;
  if (command === undefined || command === "-h" || command === "--help" || command === "help") {
    env.out(`electron-cast ${env.libraryVersion}\n\nCommands:\n  dial-test   Test a DIAL TV and write a report (electron-cast dial-test --help)\n`);
    return command === undefined ? 2 : 0;
  }
  if (command === "--version" || command === "-v") {
    env.out(env.libraryVersion);
    return 0;
  }
  if (command !== "dial-test") {
    env.err(`electron-cast: unknown command ${command}. Try: electron-cast dial-test --help`);
    return 2;
  }
  const args = parseArgs(rest);
  if (typeof args === "string") {
    env.err(`electron-cast dial-test: ${args}. Try: electron-cast dial-test --help`);
    return 2;
  }
  if (args.help) {
    env.out(USAGE);
    return 0;
  }

  const result = await runDialTest({
    libraryVersion: env.libraryVersion,
    ...(args.deviceIndex !== undefined ? { deviceIndex: args.deviceIndex } : {}),
    ...(args.seconds !== undefined ? { discoverMs: args.seconds * 1000 } : {}),
    yes: args.yes,
    launch: !args.readOnly,
    ...(env.signal !== undefined ? { signal: env.signal } : {}),
    ...env.overrides,
  }, { print: env.out, ask: env.ask });

  const file = path.resolve(env.cwd, args.out);
  (env.writeFile ?? ((f: string, text: string) => writeFileSync(f, text)))(file, result.report);
  const title = `DIAL test${result.model === "" ? "" : `: ${result.model}`}`;
  const issue = buildIssueUrl(title, result.report, { fileName: path.basename(file) });
  env.out("");
  env.out("----- report -----");
  env.out(result.report);
  env.out("----- end of report -----");
  env.out("");
  env.out(`The report is saved in ${file}.`);
  env.out("Read it before you post it. Names, serial numbers, UUIDs, MAC addresses, IP addresses and URL hosts are replaced,");
  env.out("but you are the one who can tell whether anything else in it is private.");
  env.out("");
  env.out(`To post it as an issue, open this link (it carries the report${issue.truncated ? `, cut to fit: attach ${path.basename(file)} too` : ""}):`);
  env.out(issue.url);
  return result.exitCode;
}
