#!/usr/bin/env node
// Opt-in, needs the network: checks the Chromium citations in docs/CHROMIUM-MAP.md against the Chromium tree.
//
// For each table row it fetches the linked file from raw.githubusercontent.com (chromium/chromium or chromium/openscreen,
// branch main) and looks for every backticked symbol of the "Symbols" column in it. It also checks that every
// Chromium-style path written in backticks anywhere in docs/ exists. The files are only searched as text.
//
// Usage: node tools/docs-check-chromium.mjs
// Exit codes: 0 all found, 1 something was not found, 2 could not run (network error).
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const RAW = { chromium: "https://raw.githubusercontent.com/chromium/chromium/main/", openscreen: "https://raw.githubusercontent.com/chromium/openscreen/main/" };

const cache = new Map();
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** Fetches text, or null for a 404. A 429 or 5xx is retried a few times, honouring Retry-After. */
async function fetchText(url) {
  if (!cache.has(url)) {
    cache.set(
      url,
      (async () => {
        for (let attempt = 1; ; attempt++) {
          const res = await fetch(url);
          if (res.status === 404) return null;
          if (res.ok) return res.text();
          if (attempt >= 5 || (res.status !== 429 && res.status < 500)) throw new Error(`${url}: HTTP ${res.status}`);
          const wait = Number(res.headers.get("retry-after"));
          await sleep((Number.isFinite(wait) && wait > 0 ? wait : 2 ** attempt * 5) * 1000);
        }
      })(),
    );
  }
  return cache.get(url);
}

const problems = [];
const fail = (where, message) => problems.push(`${where}: ${message}`);

/** `A::b()` -> `b`; a trailing `()` and spaces dropped. Only the last segment has to appear in the file. */
function identifier(symbol) {
  const last = symbol.split("::").pop() ?? symbol;
  return last.replace(/\(.*$/, "").trim();
}

function* markdownFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* markdownFiles(path);
    else if (entry.name.endsWith(".md")) yield path;
  }
}

let rows = 0;
let symbols = 0;
let paths = 0;

try {
  // 1. The map: every row names a linked file and the symbols found in it.
  const mapFile = join(root, "docs/CHROMIUM-MAP.md");
  for (const [index, line] of readFileSync(mapFile, "utf8").split(/\r?\n/).entries()) {
    const link = /\]\(https:\/\/github\.com\/chromium\/(chromium|openscreen)\/blob\/main\/([^)\s]+)\)/.exec(line);
    if (link === null || !line.startsWith("|")) continue;
    const where = `docs/CHROMIUM-MAP.md:${index + 1}`;
    const cells = line.split("|").map((c) => c.trim());
    // | electron-cast | Chromium file | Symbols | Mirrored | Differs |
    const symbolCell = cells[3] ?? "";
    const text = await fetchText(RAW[link[1]] + link[2]);
    rows += 1;
    if (text === null) {
      fail(where, `${link[1]}/${link[2]} does not exist on main`);
      continue;
    }
    for (const m of symbolCell.matchAll(/`([^`]+)`/g)) {
      const id = identifier(m[1]);
      symbols += 1;
      if (!new RegExp(`(?<![\\w])${id.replace(/[$]/g, "\\$")}(?![\\w])`).test(text)) fail(where, `"${m[1]}" is not in ${link[2]}`);
    }
  }

  // 2. Chromium-style paths anywhere in the docs and the sources' comments.
  const PATH = /`((?:components|chrome|content|third_party)\/[A-Za-z0-9_./+-]+\.(?:cc|h|mm|mojom|proto|js))`/g;
  const seen = new Set();
  for (const file of [...markdownFiles(join(root, "docs")), join(root, "README.md"), join(root, "SECURITY.md"), join(root, "CONTRIBUTING.md")]) {
    for (const [index, line] of readFileSync(file, "utf8").split(/\r?\n/).entries()) {
      for (const m of line.matchAll(PATH)) {
        if (seen.has(m[1])) continue;
        seen.add(m[1]);
        paths += 1;
        const text = await fetchText(RAW.chromium + m[1]);
        if (text === null) fail(`${relative(root, file)}:${index + 1}`, `${m[1]} does not exist in chromium/chromium on main`);
      }
    }
  }
} catch (error) {
  console.error(`docs:check:chromium could not run: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 2;
}

if (process.exitCode === undefined) {
  if (problems.length > 0) {
    for (const p of problems) console.error(p);
    console.error(`docs:check:chromium FAIL (${problems.length} problem${problems.length === 1 ? "" : "s"})`);
    process.exitCode = 1;
  } else {
    console.log(`docs:check:chromium ok (${rows} linked files, ${symbols} symbols, ${paths} other paths)`);
  }
}
