// The DIAL test's report: what was collected, the Markdown it becomes, and the GitHub issue link that carries it.
import type { Scrubber } from "./scrub.ts";

export type StepResult = "pass" | "fail" | "skip" | "info";

export interface Step {
  name: string;
  result: StepResult;
  detail: string;
}

/** One request made to the device, as the library's HTTP layer saw it. */
export interface RequestRecord {
  method: string;
  url: string;
  /** The HTTP status; null when no answer came (refused, timed out, aborted). */
  status: number | null;
  ms: number;
  /** The library's error text when the request failed. */
  error?: string;
}

export interface ReportData {
  environment: { os: string; node: string; library: string; interfaces: number; browser: string };
  /** The device's description fields, in the order they are shown. */
  device: Array<[label: string, value: string]> | null;
  steps: Step[];
  requests: RequestRecord[];
  /** The questions asked and the answers given. */
  answers: Array<[question: string, answer: string]>;
  appInfoXml: string | null;
  interrupted: boolean;
  /** UTC date, without a time of day. */
  date: string;
}

const cell = (text: string): string => text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

const MARK: Record<StepResult, string> = { pass: "PASS", fail: "FAIL", skip: "SKIP", info: "INFO" };

/**
 * The report as Markdown. The sections that matter most come first, because a report that does not fit in an issue
 * link is cut from the end. Everything passes through the scrubber on the way out.
 */
export function renderReport(data: ReportData, scrubber: Scrubber): string {
  const lines: string[] = [];
  lines.push("# DIAL device test report", "");
  if (data.interrupted) lines.push("**The run was interrupted (Ctrl-C); this is what had been collected.**", "");
  lines.push(`Date (UTC): ${data.date}`, "");
  lines.push("## Environment", "");
  lines.push(`- OS: ${data.environment.os}`);
  lines.push(`- Node: ${data.environment.node}`);
  lines.push(`- electron-cast: ${data.environment.library}`);
  lines.push(`- Network interfaces searched: ${data.environment.interfaces}`);
  lines.push(`- Browser identity sent to the device (search User-Agent, Origin header): ${data.environment.browser}`, "");
  lines.push("## Device", "");
  if (data.device === null || data.device.length === 0) lines.push("No device was tested.");
  else for (const [label, value] of data.device) lines.push(`- ${label}: ${value === "" ? "(not given)" : value}`);
  lines.push("", "## Results", "");
  for (const step of data.steps) lines.push(`- **${MARK[step.result]}** ${step.name}${step.detail === "" ? "" : `: ${step.detail}`}`);
  if (data.answers.length > 0) {
    lines.push("", "## Answers", "");
    for (const [question, answer] of data.answers) lines.push(`- ${question} ${answer}`);
  }
  if (data.requests.length > 0) {
    lines.push("", "## Requests", "", "| Request | Status | Time |", "|---|---|---|");
    for (const r of data.requests) {
      const status = r.status === null ? `no answer${r.error === undefined ? "" : ` (${r.error})`}` : String(r.status);
      lines.push(`| ${cell(`${r.method} ${r.url}`)} | ${cell(status)} | ${r.ms} ms |`);
    }
  }
  if (data.appInfoXml !== null) lines.push("", "## YouTube app info (as the device sent it, scrubbed)", "", "```xml", data.appInfoXml.trim(), "```");
  lines.push("");
  return scrubber.scrub(lines.join("\n"));
}

/**
 * The new-issue link with the report as its body. A URL longer than about 7000 characters is refused by some browsers
 * and servers, so the report is cut at a line boundary until the link fits, with a note that points to the file.
 */
export function buildIssueUrl(
  title: string,
  body: string,
  options: { maxLength?: number; fileName?: string; repository?: string } = {},
): { url: string; truncated: boolean } {
  const maxLength = options.maxLength ?? 7000;
  const repository = options.repository ?? "adammpkins/electron-cast";
  const base = `https://github.com/${repository}/issues/new?title=${encodeURIComponent(title)}&body=`;
  const whole = base + encodeURIComponent(body);
  if (whole.length <= maxLength) return { url: whole, truncated: false };
  const note = `\n\n_The report was cut to fit this link. Attach the whole of ${options.fileName ?? "dial-test-report.md"} to this issue._\n`;
  const lines = body.split("\n");
  let kept = lines.length;
  // Fewer lines until the encoded link fits; the lines of one report are few, so a scan from the end is cheap enough.
  while (kept > 0 && (base + encodeURIComponent(lines.slice(0, kept).join("\n") + note)).length > maxLength) kept--;
  let text = lines.slice(0, kept).join("\n");
  // A single line longer than the limit is cut inside the line, never between the two halves of a character.
  if (kept === 0) {
    let cut = body.length;
    while (cut > 0 && (base + encodeURIComponent(body.slice(0, cut) + note)).length > maxLength) cut = Math.floor(cut * 0.8);
    const code = body.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut--;
    text = body.slice(0, cut);
  }
  return { url: base + encodeURIComponent(text + note), truncated: true };
}
