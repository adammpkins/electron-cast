#!/usr/bin/env node
/* ============================================================================
   electron-cast README art kit.

   Cuts the README images from this repo's own site (site/), its brand files and
   its data, and writes them under docs/readme/. Nothing is drawn freehand: the
   hero and the gallery cuts are screenshots of the real landing page, the badges
   read their facts from package.json, the signal-path log is the recorded Cast v2
   trace (site/.vitepress/data/trace.json) set as an animated SVG, and the brand
   board is composed from the real files under site/public/brand/.

   Run from any folder (every path resolves from this file's own location):

     npm --prefix site ci
     npm --prefix site run build
     npm --prefix scripts/readme-art ci
     npx --prefix scripts/readme-art playwright install chromium
     node scripts/readme-art/build.mjs

   The built site is served from 127.0.0.1 and every other request is aborted, so
   nothing leaves the machine. Same inputs, same outputs.
   ========================================================================== */

import { chromium } from "playwright";
import { makeBadge } from "badge-maker";
import sharp from "sharp";
import http from "node:http";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/* ------------------------------------------------------------- paths, limits */

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..");
const siteDir = path.join(repoRoot, "site");
const distDir = path.join(siteDir, ".vitepress", "dist");
const outDir = path.join(repoRoot, "docs", "readme");
const BASE = "/electron-cast/";

const MAX_BYTES = 300 * 1024; // every file in docs/readme/ stays at or under this
// Words that must never appear in a published image or its text.
const FORBIDDEN = /chatg[p]t|open[a]i|anthrop[i]c|clau[d]e|potrac[e]|brandboar[d]|generated [b]y|made with [a]i|ai-generate[d]/i; // written with character classes so this line does not match itself

const outputs = [];
const record = (rel, buf) => {
  const abs = path.join(outDir, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, buf);
  outputs.push({ rel, bytes: buf.length });
  console.log(`  ${rel}  ${buf.length} bytes`);
};
const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
};
const clean = (text, what) => {
  if (FORBIDDEN.test(text)) fail(`forbidden text matched ${FORBIDDEN} in ${what}`);
};
const readText = (rel) => {
  const abs = path.join(repoRoot, rel);
  if (!existsSync(abs)) fail(`missing source ${rel}`);
  return readFileSync(abs, "utf8");
};
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// The brand palette, read from the brand build script so there is one source.
const palette = {};
for (const m of readText("site/brand/build.mjs").matchAll(/^\s+(\w+):\s*"(#[0-9A-Fa-f]{6})"/gm)) palette[m[1]] = m[2];
for (const k of ["ink", "paper", "tally", "tallyText", "graphite", "rule"]) if (!palette[k]) fail(`palette key ${k} not found in site/brand/build.mjs`);
const C = palette;

const pkg = JSON.parse(readText("package.json"));
if (!existsSync(path.join(distDir, "index.html"))) fail("the site is not built: run `npm --prefix site run build` first");

const jpg = async (input, { width, quality = 84 } = {}) => {
  let q = quality;
  for (;;) {
    const buf = await sharp(input).resize({ width, withoutEnlargement: true }).jpeg({ quality: q, mozjpeg: true }).toBuffer();
    if (buf.length <= MAX_BYTES || q <= 50) return buf;
    q -= 6;
  }
};

/* ------------------------------------------------------------- 1. badges */

function badges() {
  const lib = pkg.dependencies ? Object.keys(pkg.dependencies).length : 0;
  const data = [
    { key: "node", label: "node", message: pkg.engines?.node ?? fail("package.json has no engines.node") },
    { key: "electron", label: "electron", message: pkg.peerDependencies?.electron ?? fail("package.json has no electron peer dependency") },
    { key: "license", label: "license", message: pkg.license ?? fail("package.json has no license") },
    { key: "dependencies", label: "runtime dependencies", message: String(lib) },
  ];
  for (const d of data) {
    const svg = makeBadge({ label: d.label, message: d.message, labelColor: C.ink, color: C.tallyText, style: "flat-square" });
    clean(svg, `badge ${d.key}`);
    record(`badges/${d.key}.svg`, Buffer.from(svg));
  }
}

/* ------------------------------------------------------------- 2. the recorded trace, as an animated SVG */

function traceSvg() {
  const trace = JSON.parse(readText("site/.vitepress/data/trace.json"));
  const frames = trace.frames;
  if (!Array.isArray(frames) || !frames.length) fail("trace.json has no frames");
  const fontFile = path.join(siteDir, "node_modules", "@fontsource", "commit-mono", "files", "commit-mono-latin-400-normal.woff2");
  const font = readFileSync(fontFile).toString("base64");
  const short = (ns) => ns.replace("urn:x-cast:com.google.cast.", "");
  // A window of VISIBLE rows scrolls up as frames arrive, so the whole session fits a README-sized image.
  const W = 960, ROW = 24, TOP = 96, VISIBLE = 16, BODY = VISIBLE * ROW, H = TOP + BODY + 44;
  const GAP = 1500;
  const gapOf = (i) => (i > 0 ? frames[i].t - frames[i - 1].t : 0);
  // replay clock: real gaps up to 1.5 s, longer silences shortened to 1.5 s, never faster than 0.2 s
  const INTRO = 1.6, HOLD = 3.4;
  const starts = [];
  let clock = INTRO;
  frames.forEach((_, i) => {
    if (i > 0) clock += Math.max(0.2, Math.min(gapOf(i), GAP) / 1000);
    starts.push(clock);
  });
  const cycle = clock + HOLD;
  const pct = (s) => ((s / cycle) * 100).toFixed(2);
  const loadAt = frames.findIndex((f) => f.type === "LOAD");
  const stopAt = frames.findIndex((f, i) => f.type === "STOP" && i > loadAt);
  const liveFrom = loadAt >= 0 ? starts[loadAt] : cycle;
  const liveTo = stopAt >= 0 ? starts[stopAt] : cycle;
  const caption = `Recorded from a real session: ${String(trace.library ?? "electron-cast").replace("@", " ")} casting to a ${trace.device?.model ?? "Chromecast"}.`;
  let css = `@font-face{font-family:CM;src:url(data:font/woff2;base64,${font}) format("woff2")}
text{font-family:CM,ui-monospace,Menlo,Consolas,monospace;font-size:13px;fill:${C.paper}}
.dim{fill:#A29D92}.tally{fill:${C.tally}}.bar{fill:${C.tally}}
.nosig{animation:nosig ${cycle}s steps(1,end) infinite}
@keyframes nosig{0%{opacity:1}${pct(INTRO)}%,100%{opacity:0}}
.air{opacity:0;animation:air ${cycle}s steps(1,end) infinite}
@keyframes air{0%{opacity:0}${pct(liveFrom)}%{opacity:1}${pct(liveTo)}%,100%{opacity:0}}`;
  // the scroll: one keyframes rule, one step per frame once the window is full
  let scroll = "0%{transform:translateY(0)}";
  frames.forEach((_, i) => {
    if (i >= VISIBLE) scroll += `${pct(starts[i])}%{transform:translateY(${-(i - VISIBLE + 1) * ROW}px)}`;
  });
  css += `.rows{animation:scroll ${cycle}s steps(1,end) infinite}@keyframes scroll{${scroll}${pct(cycle - 0.4)}%,100%{transform:translateY(0)}}`;
  let rows = "";
  frames.forEach((f, i) => {
    const y = TOP + i * ROW;
    const b = i + 1 < frames.length ? starts[i + 1] : cycle - HOLD / 2;
    css += `.r${i}{opacity:0;animation:r${i} ${cycle}s steps(1,end) infinite}@keyframes r${i}{0%{opacity:0}${pct(starts[i])}%{opacity:1}${pct(cycle - 0.4)}%,100%{opacity:0}}`;
    css += `.n${i}{opacity:0;animation:n${i} ${cycle}s steps(1,end) infinite}@keyframes n${i}{0%{opacity:0}${pct(starts[i])}%{opacity:1}${pct(b)}%,100%{opacity:0}}`;
    const arrow = f.dir === "out" ? "→" : "←";
    const gap = gapOf(i) > GAP ? `<text x="${W - 24}" y="${y}" text-anchor="end" class="dim" style="font-size:11px">+${(gapOf(i) / 1000).toFixed(1)} s silence</text>` : "";
    rows += `<g class="r${i}"><line x1="24" x2="${W - 24}" y1="${y + 7}" y2="${y + 7}" stroke="#2A2721"/>` +
      `<text x="44" y="${y}" class="dim">+${(f.t / 1000).toFixed(3)}s</text>` +
      `<text x="150" y="${y}" class="${f.dir === "in" ? "tally" : ""}">${arrow}</text>` +
      `<text x="176" y="${y}" style="font-weight:700">${esc(f.type)}</text>` +
      `<text x="330" y="${y}">${esc(short(f.namespace))}</text>` +
      `<text x="500" y="${y}" class="dim">${esc(f.source)} to ${esc(f.destination)}</text>${gap}</g>` +
      `<rect class="bar n${i}" x="24" y="${y - 15}" width="3" height="21"/>`;
  });
  const staticSel = frames.map((_, i) => `.r${i}`).join(",");
  const noteSel = frames.map((_, i) => `.n${i}`).join(",");
  const desc = `${frames.length} frames from a recorded Cast v2 session between electron-cast and a Chromecast Ultra: device authentication, CONNECT, GET_STATUS, LAUNCH of the Default Media Receiver, RECEIVER_STATUS, media LOAD and MEDIA_STATUS, PING and PONG, PAUSE and PLAY, then STOP and CLOSE. Each frame appears in turn as a log row, silences over 1.5 seconds are marked and shortened, and ON AIR lights from LOAD to STOP. With reduced motion the first ${VISIBLE} frames show as a still.`;
  const barW = (W - 48) / 6;
  const card = ["#8C8A85", "#74726D", "#5D5B57", "#46443F", "#2F2D2A", "#1D1B18"].map((c, i) => `<rect x="${24 + i * barW}" y="${TOP}" width="${barW}" height="${BODY - 70}" fill="${c}"/>`).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-labelledby="t d"><title id="t">Recorded Cast v2 session</title><desc id="d">${esc(desc)}</desc>
<style>${css}@media (prefers-reduced-motion:reduce){.rows,${staticSel},.air{animation:none!important;opacity:1!important;transform:none!important}.nosig,${noteSel}{animation:none!important;opacity:0!important}}</style>
<defs><clipPath id="win"><rect x="2" y="${TOP - 18}" width="${W - 4}" height="${BODY + 6}"/></clipPath></defs>
<rect width="${W}" height="${H}" fill="${C.ink}"/>
<rect x="1" y="1" width="${W - 2}" height="${H - 2}" fill="none" stroke="${C.paper}" stroke-width="2"/>
<text x="24" y="38" style="font-size:15px;letter-spacing:1.5px">RECORDED CAST V2 SESSION</text>
<text x="24" y="60" class="dim">${esc(caption)} Big Buck Bunny &#169; Blender Foundation, CC BY 3.0.</text>
<rect x="${W - 130}" y="26" width="11" height="11" fill="none" stroke="#A29D92" stroke-width="1.5"/>
<g class="air"><rect x="${W - 130}" y="26" width="11" height="11" class="bar"/><text x="${W - 112}" y="37" style="letter-spacing:1.5px">ON AIR</text></g>
<line x1="24" x2="${W - 24}" y1="74" y2="74" stroke="${C.paper}" stroke-width="2"/>
<g clip-path="url(#win)"><g class="rows">${rows}</g></g>
<g class="nosig"><rect x="2" y="76" width="${W - 4}" height="${H - 78}" fill="${C.ink}"/>${card}
<text x="24" y="${TOP + BODY - 40}" style="font-size:20px;letter-spacing:3px">NO SIGNAL</text>
<text x="24" y="${TOP + BODY - 16}" class="dim">replaying a recorded session</text></g>
<text x="${W - 24}" y="${H - 14}" text-anchor="end" class="dim" style="font-size:11px">${frames.length} frames</text>
</svg>`;
  clean(svg.replace(/base64,[A-Za-z0-9+/=]+/, ""), "trace.svg");
  record("trace.svg", Buffer.from(svg));
}

/* ------------------------------------------------------------- 3. the site, served locally */

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2", ".woff": "font/woff", ".webmanifest": "application/manifest+json" };
function serve() {
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent((req.url ?? "/").split("?")[0]);
    if (!p.startsWith(BASE)) { res.writeHead(404).end(); return; }
    p = p.slice(BASE.length) || "index.html";
    if (p.endsWith("/")) p += "index.html";
    let abs = path.join(distDir, p);
    if (!abs.startsWith(distDir)) { res.writeHead(403).end(); return; }
    if (!existsSync(abs) && existsSync(abs + ".html")) abs += ".html";
    if (!existsSync(abs) || statSync(abs).isDirectory()) { res.writeHead(404).end(); return; }
    res.writeHead(200, { "content-type": MIME[path.extname(abs)] ?? "application/octet-stream" }).end(readFileSync(abs));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, origin: `http://127.0.0.1:${server.address().port}` })));
}

async function pageShots(browser, origin) {
  const blocked = [];
  const open = async (scheme) => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: scheme, reducedMotion: "reduce", deviceScaleFactor: 1 });
    await ctx.route("**/*", (route) => {
      const u = route.request().url();
      if (u.startsWith(origin) || u.startsWith("data:")) return route.continue();
      blocked.push(u);
      return route.abort();
    });
    const page = await ctx.newPage();
    await page.goto(`${origin}${BASE}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(500);
    return { ctx, page };
  };

  for (const scheme of ["light", "dark"]) {
    const { ctx, page } = await open(scheme);
    const hero = page.locator("header.hero");
    clean(await hero.innerText(), `hero ${scheme}`);
    record(`hero-${scheme}.jpg`, await jpg(await hero.screenshot(), { width: 1400 }));
    if (scheme === "light") {
      // gallery 1: the parity table with its first row open
      const parity = page.locator(".parity");
      await parity.scrollIntoViewIfNeeded();
      await parity.locator("summary").first().click();
      await page.waitForTimeout(150);
      clean(await parity.innerText(), "parity");
      record("parity.jpg", await jpg(await parity.screenshot(), { width: 1400 }));
      // gallery 2: the replay at rest, the NO SIGNAL card
      const trace = page.locator(".trace");
      await trace.scrollIntoViewIfNeeded();
      clean(await trace.innerText(), "trace");
      record("nosignal.jpg", await jpg(await trace.screenshot(), { width: 1400 }));
    }
    await ctx.close();
  }
  return blocked;
}

/* ------------------------------------------------------------- 4. the brand board, composed from the real files */

async function board(browser) {
  const file = (rel) => pathToFileURL(path.join(siteDir, rel)).href;
  const archivo = file("node_modules/@fontsource-variable/archivo/files/archivo-latin-wdth-normal.woff2");
  const commit = file("node_modules/@fontsource/commit-mono/files/commit-mono-latin-400-normal.woff2");
  const swatches = [
    ["Ink", C.ink, "text, rules, the dark ground", C.paper],
    ["Paper", C.paper, "the light ground", C.ink],
    ["Tally", C.tally, "the one signal colour: fills and dots", C.ink],
    ["Tally, text", C.tallyText, "small text and rules on paper", C.paper],
    ["Graphite", C.graphite, "secondary text", C.paper],
    ["Rule", C.rule, "hairlines", C.ink],
  ];
  const html = `<!doctype html><meta charset="utf-8"><style>
@font-face{font-family:Archivo;src:url(${archivo}) format("woff2");font-weight:100 900;font-stretch:62% 125%}
@font-face{font-family:CM;src:url(${commit}) format("woff2")}
*{box-sizing:border-box;margin:0}
body{width:1600px;height:1000px;background:${C.paper};color:${C.ink};font-family:CM,monospace;font-size:13px;padding:36px;
 background-image:linear-gradient(rgba(21,19,15,.06) 1px,transparent 1px),linear-gradient(90deg,rgba(21,19,15,.06) 1px,transparent 1px);background-size:40px 40px}
.grid{display:grid;grid-template-columns:1.05fr 1.2fr 1fr;grid-template-rows:auto 1fr 1fr;gap:20px;height:100%}
.p{border:2px solid ${C.ink};background:${C.paper};padding:18px;display:flex;flex-direction:column;gap:12px;min-height:0}
.p h2{font-size:12px;letter-spacing:.1em;text-transform:uppercase;font-weight:400;color:${C.graphite}}
.head{grid-column:1/-1;flex-direction:row;align-items:baseline;justify-content:space-between}
.head b{font-family:Archivo;font-stretch:70%;font-weight:850;font-size:44px;letter-spacing:-.01em}
.dark{background:${C.ink};color:${C.paper}}.dark h2{color:#A29D92}
.mark{display:flex;gap:16px;align-items:center;justify-content:center;flex:1}
.mark img{height:150px}.tile{display:flex;align-items:center;justify-content:center;flex:1;padding:14px}
.sw{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;flex:1}
.sw div{padding:10px;display:flex;flex-direction:column;justify-content:flex-end;border:1px solid ${C.ink};line-height:1.45}
.sw small{opacity:.85}
.spec{font-family:Archivo;font-stretch:70%;font-weight:850;font-size:64px;line-height:.95;letter-spacing:-.01em}
.body{font-family:Archivo;font-stretch:100%;font-weight:400;font-size:17px;line-height:1.5}
.fav{display:flex;align-items:flex-end;gap:18px;flex:1}
.fav figure{display:flex;flex-direction:column;align-items:center;gap:6px}
</style><div class="grid">
<div class="p head"><b>electron-cast</b><span>brand board: mark, lockups, palette, type, icon sizes</span></div>
<div class="p"><h2>Mark</h2><div class="mark"><img src="${file("public/brand/mark.svg")}" alt=""><img src="${file("public/brand/mark-on-dark.svg")}" alt="" style="background:${C.ink};padding:18px"></div></div>
<div class="p"><h2>Palette</h2><div class="sw">${swatches.map(([n, c, r, t]) => `<div style="background:${c};color:${t}"><b>${n}</b><span>${c}</span><small>${r}</small></div>`).join("")}</div></div>
<div class="p"><h2>Type</h2><div class="spec">Chromecast<br>for Electron.</div><p class="body">Archivo, condensed and heavy for display, normal width for text.</p><p style="font-size:15px">createCastManager({ ipcMain })<br><span style="color:${C.graphite}">Commit Mono, for code and labels</span></p></div>
<div class="p"><h2>Lockup, on paper</h2><div class="tile"><img src="${file("public/brand/lockup.svg")}" alt="" style="height:64px"></div></div>
<div class="p dark"><h2>Lockup, on ink</h2><div class="tile"><img src="${file("public/brand/lockup-on-dark.svg")}" alt="" style="height:64px"></div></div>
<div class="p"><h2>Icon sizes</h2><div class="fav">
 <figure><img src="${file("public/icon-512.png")}" width="128" height="128" alt=""><span>512 icon</span></figure>
 <figure><img src="${file("public/apple-touch-icon.png")}" width="96" height="96" alt=""><span>touch 180</span></figure>
 <figure><img src="${file("public/favicon.svg")}" width="48" height="48" alt=""><span>48</span></figure>
 <figure><img src="${file("public/favicon.svg")}" width="32" height="32" alt=""><span>32</span></figure>
 <figure><img src="${file("public/favicon.svg")}" width="16" height="16" alt=""><span>16</span></figure></div></div>
</div>`;
  // file URLs carry this machine's folder names; only the board's own text is checked
  clean(html.replace(/<style>[\s\S]*?<\/style>/, "").replace(/file:[^"')]+/g, ""), "board");
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
  await ctx.route("**/*", (route) => {
    const u = route.request().url();
    return u.startsWith("file:") || u.startsWith("data:") || u === "about:blank" ? route.continue() : route.abort();
  });
  const page = await ctx.newPage();
  const tmp = path.join(scriptDir, ".board.html");
  writeFileSync(tmp, html);
  await page.goto(pathToFileURL(tmp).href, { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
  record("board.jpg", await jpg(await page.screenshot(), { width: 1600 }));
  await ctx.close();
  rmSync(tmp, { force: true });
}

/* ------------------------------------------------------------- run */

console.log("electron-cast README art");
rmSync(outDir, { recursive: true, force: true });
badges();
traceSvg();
const { server, origin } = await serve();
const browser = await chromium.launch();
const blocked = await pageShots(browser, origin);
await board(browser);
await browser.close();
server.close();
if (blocked.length) fail(`the page tried to reach outside the machine: ${[...new Set(blocked)].join(", ")}`);

for (const o of outputs) if (o.bytes > MAX_BYTES) fail(`${o.rel} is ${o.bytes} bytes, over ${MAX_BYTES}`);
const all = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? all(path.join(dir, e.name)) : [path.join(dir, e.name)]));
for (const f of all(outDir)) clean(path.relative(outDir, f), "file name");
console.log(`done: ${outputs.length} files, all <= ${MAX_BYTES / 1024} KB, no requests left the machine`);
