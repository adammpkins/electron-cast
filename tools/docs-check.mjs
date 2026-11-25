#!/usr/bin/env node
// Documentation checks. No network, no build: it reads the Markdown and the TypeScript sources.
//
//   1. exports: every name the package root exports appears in docs/API.md or docs/MAIN-API.md.
//   2. code:    every ```ts block in the docs typechecks against the package's own sources, as an app would
//               import them ("electron-cast", "electron-cast/main", "electron-cast/preload", "electron-cast/polyfill").
//               A block that is a fragment says so with `<!-- no-check -->` on the line before its fence, or `no-check` after `ts` in the fence.
//   3. links:   every relative link and #anchor in the Markdown resolves (anchors use GitHub's heading slugs).
//
// Usage: node tools/docs-check.mjs [--only exports|code|links]...
// Exit code: 0 all passed, 1 a check failed.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("..", import.meta.url));
const problems = [];
const fail = (where, message) => problems.push(`${where}: ${message}`);
const rel = (p) => relative(root, p).split(sep).join("/");

/** The Markdown files that make up the documentation. */
function markdownFiles() {
  const files = ["README.md", "CONTRIBUTING.md", "SECURITY.md", "CHANGELOG.md"].map((f) => join(root, f)).filter(existsSync);
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith(".md")) files.push(full);
    }
  };
  walk(join(root, "docs"));
  return files;
}

/** Lines of a Markdown file with fenced code blocks marked, so prose checks can skip code. */
function scan(text) {
  const lines = text.split("\n");
  const fences = [];
  let open = null;
  lines.forEach((line, i) => {
    const m = /^(\s*)(`{3,}|~{3,})(.*)$/.exec(line);
    if (m === null) return;
    if (open === null) {
      open = { start: i, marker: m[2][0], length: m[2].length, info: m[3].trim() };
    } else if (m[2][0] === open.marker && m[2].length >= open.length && m[3].trim() === "") {
      fences.push({ ...open, end: i });
      open = null;
    }
  });
  const inCode = new Set();
  for (const f of fences) for (let i = f.start; i <= f.end; i++) inCode.add(i);
  return { lines, fences, inCode };
}

const files = markdownFiles();
const parsed = new Map(files.map((f) => [f, scan(readFileSync(f, "utf8"))]));

// ---------------------------------------------------------------- exports

function checkExports() {
  const config = ts.readConfigFile(join(root, "tsconfig.json"), ts.sys.readFile);
  const options = ts.parseJsonConfigFileContent(config.config, ts.sys, root).options;
  const entry = join(root, "src/index.ts");
  const program = ts.createProgram([entry], options);
  const checker = program.getTypeChecker();
  const names = checker.getExportsOfModule(checker.getSymbolAtLocation(program.getSourceFile(entry))).map((s) => s.name);
  const apiDocs = ["docs/API.md", "docs/MAIN-API.md"].map((f) => readFileSync(join(root, f), "utf8")).join("\n");
  for (const name of names) {
    if (!new RegExp(`(?<![\\w$])${name.replace(/\$/g, "\\$")}(?![\\w$])`).test(apiDocs)) {
      fail("docs/API.md", `public export "${name}" is not mentioned in docs/API.md or docs/MAIN-API.md`);
    }
  }
  return names.length;
}

// ---------------------------------------------------------------- code blocks

const ELECTRON_STUB = `declare module "electron" {
  export const app: any;
  export const BrowserWindow: any;
  export const BrowserView: any;
  export const WebContentsView: any;
  export const Menu: any;
  export const dialog: any;
  export const ipcMain: any;
  export const ipcRenderer: any;
  export const contextBridge: any;
  export const session: any;
  export const shell: any;
  export const Tray: any;
  export const screen: any;
  export const powerMonitor: any;
}
`;

function checkCode() {
  const blocks = [];
  for (const [file, { lines, fences }] of parsed) {
    for (const f of fences) {
      if (!/^(ts|typescript)\b/.test(f.info) || /\bno-check\b/.test(f.info)) continue;
      let k = f.start - 1;
      while (k >= 0 && lines[k].trim() === "") k--;
      if (k >= 0 && lines[k].trim() === "<!-- no-check -->") continue;
      blocks.push({ file, line: f.start + 1, code: lines.slice(f.start + 1, f.end).join("\n") });
    }
  }
  if (blocks.length === 0) return 0;

  const dir = mkdtempSync(join(tmpdir(), "electron-cast-docs-"));
  try {
    const sources = new Map();
    blocks.forEach((b, i) => {
      const path = join(dir, `block${i}.ts`);
      // `export {}` makes every block a module, so top-level await and repeated names do not collide
      sources.set(path, `${b.code}\nexport {};\n`);
      b.path = path;
    });
    const stubPath = join(dir, "electron-stub.d.ts");
    let haveElectron = false;
    try {
      createRequire(join(root, "package.json")).resolve("electron/package.json");
      haveElectron = true;
    } catch {
      // not installed (it is an optional peer dependency): use the stub
    }
    if (!haveElectron) sources.set(stubPath, ELECTRON_STUB);

    const options = {
      target: ts.ScriptTarget.ES2023,
      lib: ["lib.es2023.d.ts", "lib.dom.d.ts"],
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      strict: true,
      noImplicitAny: false, // doc snippets leave callback parameters untyped
      noEmit: true,
      skipLibCheck: true,
      allowImportingTsExtensions: true,
      types: ["node"],
      typeRoots: [join(root, "node_modules/@types")],
      paths: {
        "electron-cast": [join(root, "src/index.ts")],
        "electron-cast/main": [join(root, "src/electron/main.ts")],
        "electron-cast/preload": [join(root, "src/electron/preload.ts")],
        "electron-cast/polyfill": [join(root, "src/polyfill/install.ts")],
      },
    };
    const host = ts.createCompilerHost(options);
    const readFile = host.readFile.bind(host);
    const fileExists = host.fileExists.bind(host);
    host.readFile = (p) => sources.get(resolve(p)) ?? readFile(p);
    host.fileExists = (p) => sources.has(resolve(p)) || fileExists(p);
    const original = host.getSourceFile.bind(host);
    host.getSourceFile = (p, lang, ...rest) => {
      const text = sources.get(resolve(p));
      return text === undefined ? original(p, lang, ...rest) : ts.createSourceFile(p, text, lang, true);
    };
    const program = ts.createProgram([...sources.keys()], options, host);
    for (const d of ts.getPreEmitDiagnostics(program)) {
      if (d.file === undefined) {
        fail("docs", ts.flattenDiagnosticMessageText(d.messageText, "\n"));
        continue;
      }
      const block = blocks.find((b) => resolve(b.path) === resolve(d.file.fileName));
      if (block === undefined) continue;
      const { line } = d.file.getLineAndCharacterOfPosition(d.start ?? 0);
      fail(`${rel(block.file)}:${block.line + line + 1}`, `TS${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, "\n")} (mark a fragment with <!-- no-check -->)`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return blocks.length;
}

// ---------------------------------------------------------------- links

/** GitHub's heading slug: lower case, markup and punctuation dropped, spaces to hyphens. */
function slug(heading) {
  return heading
    .replace(/<[^>]+>/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*_~]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

function anchorsOf(file) {
  const { lines, inCode } = parsed.get(file) ?? scan(readFileSync(file, "utf8"));
  const seen = new Map();
  const anchors = new Set();
  lines.forEach((line, i) => {
    if (inCode.has(i)) return;
    const m = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (m === null) return;
    const base = slug(m[1]);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    anchors.add(n === 0 ? base : `${base}-${n}`);
  });
  for (const m of lines.join("\n").matchAll(/<a\s+(?:name|id)="([^"]+)"/g)) anchors.add(m[1]);
  return anchors;
}

function checkLinks() {
  const anchorCache = new Map();
  const anchors = (file) => {
    if (!anchorCache.has(file)) anchorCache.set(file, anchorsOf(file));
    return anchorCache.get(file);
  };
  let count = 0;
  for (const [file, { lines, inCode }] of parsed) {
    lines.forEach((line, i) => {
      if (inCode.has(i)) return;
      // Inline code can hold `[x](y)` as an example; drop it before looking for links.
      const text = line.replace(/`[^`]*`/g, "");
      for (const m of text.matchAll(/!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) {
        const target = m[1];
        if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue; // http:, https:, mailto:
        count++;
        const where = `${rel(file)}:${i + 1}`;
        const hash = target.indexOf("#");
        const pathPart = hash === -1 ? target : target.slice(0, hash);
        const anchor = hash === -1 ? "" : decodeURIComponent(target.slice(hash + 1));
        const dest = pathPart === "" ? file : resolve(dirname(file), decodeURIComponent(pathPart));
        if (!existsSync(dest)) {
          fail(where, `link target "${target}" does not exist`);
          continue;
        }
        if (anchor !== "" && dest.endsWith(".md") && !anchors(dest).has(anchor)) {
          fail(where, `no heading for anchor "#${anchor}" in ${rel(dest)}`);
        }
      }
    });
  }
  return count;
}

// ---------------------------------------------------------------- main

const only = process.argv.flatMap((a, i, all) => (all[i - 1] === "--only" ? [a] : []));
const run = (name) => only.length === 0 || only.includes(name);
const summary = [];
if (run("exports")) summary.push(`${checkExports()} exports`);
if (run("code")) summary.push(`${checkCode()} code blocks`);
if (run("links")) summary.push(`${checkLinks()} relative links`);

if (problems.length > 0) {
  console.error(problems.join("\n"));
  console.error(`docs:check FAIL (${problems.length} problem${problems.length === 1 ? "" : "s"})`);
  process.exit(1);
}
console.log(`docs:check ok (${summary.join(", ")})`);
