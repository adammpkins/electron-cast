// Builds every brand asset (SVG, PNG, ICO) from the mark (brand/mark.json) and the palette below. Text is outlined with opentype.js from static
// cuts of the self-hosted Archivo font (brand/instance.py), so no asset needs a font at render time.
// Run from site/: python brand/instance.py ... (see BRAND.md), then `npm run brand`.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import opentype from "opentype.js";
import { optimize } from "svgo";
import { chromium } from "playwright-core";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "public");
const brandOut = join(out, "brand");
await mkdir(brandOut, { recursive: true });

export const C = {
  ink: "#15130F",
  paper: "#F4F1EA",
  tally: "#FF4A1C", // the one signal colour: fills, dots, marks
  tallyText: "#B02A06", // tally as small text on paper (5.9:1)
  graphite: "#5A564E",
  rule: "#D7D2C7",
};

// ---------------------------------------------------------------- the mark (64 x 64 grid)
// The mark: two flat layers, the c and the square, on a 64-unit grid.
const mk = JSON.parse(await readFile(join(here, "mark.json"), "utf8"));
const mark = (c, sq) => `<path d="${mk.c}" fill="${c}"/><path d="${mk.square}" fill="${sq}"/>`;
const svg = (w, h, body, extra = "") =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"${extra}>${body}</svg>\n`;
const title = (t) => `<title>${t}</title>`;

const files = {};
files["brand/mark.svg"] = svg(64, 64, title("electron-cast") + mark(C.ink, C.tally));
files["brand/mark-on-dark.svg"] = svg(64, 64, title("electron-cast") + mark(C.paper, C.tally));
files["brand/mark-mono-ink.svg"] = svg(64, 64, title("electron-cast") + mark(C.ink, C.ink));
files["brand/mark-mono-white.svg"] = svg(64, 64, title("electron-cast") + mark("#FFFFFF", "#FFFFFF"));
// The app icon is the mark on an ink tile, as in the approved render. The favicon crops the mark in a little further.
const tileBody = (r, k) => `<rect width="64" height="64" rx="${r}" fill="${C.ink}"/><g transform="translate(${(32 - 32 * k).toFixed(2)} ${(32 - 32 * k).toFixed(2)}) scale(${k})">${mark(C.paper, C.tally)}</g>`;
files["brand/app-icon.svg"] = svg(64, 64, title("electron-cast") + tileBody(14, 0.82));
files["favicon.svg"] = svg(64, 64, title("electron-cast") + tileBody(12, 1.0));

// ---------------------------------------------------------------- text outlines
const loadFont = async (f) => {
  const b = await readFile(join(here, ".cache", f));
  return opentype.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
};
const fontWide = await loadFont("archivo-wordmark.ttf");
const fontCard = await loadFont("archivo-card.ttf");
const n2 = (v) => String(Math.round(v * 100) / 100);
function pathData(path) {
  return path.commands
    .map((c) => {
      if (c.type === "Z") return "Z";
      const pts = c.type === "M" || c.type === "L" ? [c.x, c.y] : c.type === "Q" ? [c.x1, c.y1, c.x, c.y] : [c.x1, c.y1, c.x2, c.y2, c.x, c.y];
      return c.type + pts.map(n2).join(" ");
    })
    .join("");
}
function textPath(font, str, size, x, y, fill, letterSpacing = 0) {
  let cx = x;
  const parts = [];
  for (const ch of str) {
    const g = font.charToGlyph(ch);
    parts.push(pathData(g.getPath(cx, y, size)));
    cx += (g.advanceWidth / font.unitsPerEm) * size + letterSpacing;
  }
  return { d: parts.join(""), width: cx - x - letterSpacing, markup: `<path d="${parts.join("")}" fill="${fill}"/>` };
}
// wordmark: "electron-cast" in lowercase heavy condensed Archivo
function wordmark(size, x, y, ink, _unused) {
  const t = textPath(fontWide, "electron-cast", size, x, y, ink, size * 0.005);
  return { width: t.width, xh: (fontWide.tables.os2.sxHeight / fontWide.unitsPerEm) * size, markup: t.markup };
}
{
  const size = 62;
  const w = wordmark(size, 0, 50, C.ink);
  files["brand/wordmark.svg"] = svg(Math.ceil(w.width), 64, title("electron-cast") + w.markup);
  const wd = wordmark(size, 0, 50, C.paper);
  files["brand/wordmark-on-dark.svg"] = svg(Math.ceil(wd.width), 64, title("electron-cast") + wd.markup);
}
// lockup: mark then wordmark, the mark's x-height-matched
function lockup(ink, signal, markInk) {
  const size = 62;
  const w = wordmark(size, 80, 58, ink);
  const width = Math.ceil(80 + w.width + 4);
  return svg(
    width,
    72,
    title("electron-cast") + `<g transform="translate(0 4)">${mark(markInk, signal)}</g>` + w.markup,
  );
}
files["brand/lockup.svg"] = lockup(C.ink, C.tally, C.ink);
files["brand/lockup-on-dark.svg"] = lockup(C.paper, C.tally, C.paper);

// ---------------------------------------------------------------- motifs of the social card
const gridPattern = (id, size, color, op) =>
  `<pattern id="${id}" width="${size}" height="${size}" patternUnits="userSpaceOnUse"><path d="M${size} 0H0V${size}" fill="none" stroke="${color}" stroke-opacity="${op}" stroke-width="1"/></pattern>`;
function banner(W, H, dark, tagline, sub) {
  const bg = dark ? C.ink : C.paper;
  const fg = dark ? C.paper : C.ink;
  const s = W / 1200;
  const pad = 72 * s;
  const lm = wordmark(60 * s, pad + 92 * s, pad + 72 * s, fg);
  const tl = textPath(fontWide, tagline, 92 * s, pad, H - pad - (sub ? 66 : 8) * s, fg, 0);
  const sb = sub ? textPath(fontCard, sub, 26 * s, pad, H - pad - 14 * s, dark ? "#A29D92" : C.graphite, 0) : { markup: "" };
  return svg(
    W,
    H,
    title("electron-cast: Chromecast for Electron") +
      `<defs>${gridPattern("g", 40 * s, fg, dark ? 0.09 : 0.1)}</defs>` +
      `<rect width="${W}" height="${H}" fill="${bg}"/><rect width="${W}" height="${H}" fill="url(#g)"/>` +
      `<g transform="translate(${pad} ${pad - 6 * s}) scale(${(1.3 * s).toFixed(3)})">${mark(fg, C.tally)}</g>` +
      lm.markup +
      tl.markup +
      sb.markup +
      `<rect x="${pad}" y="${H - 18 * s}" width="${W - 2 * pad}" height="${2 * s}" fill="${fg}"/><rect x="${W - pad - 18 * s}" y="${H - 26 * s}" width="${18 * s}" height="${18 * s}" fill="${C.tally}"/>`,
  );
}
files["brand/og.svg"] = banner(1200, 630, true, "Chromecast for Electron.", "Google's own Cast SDK, running unchanged in your app.");

const svgo = { multipass: true, plugins: ["preset-default"] };
for (const [name, raw] of Object.entries(files)) {
  const body = optimize(raw, svgo).data;
  files[name] = body;
  const target = join(out, name);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, body);
}

// ---------------------------------------------------------------- raster outputs
const browser = await chromium.launch();
async function png(svgText, w, h, file, bg) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  await page.setContent(
    `<style>html,body{margin:0;background:${bg ?? "transparent"}}svg{display:block;width:${w}px;height:${h}px}</style>${svgText}`,
  );
  const buf = await page.screenshot({ omitBackground: !bg, type: "png" });
  await page.close();
  if (file) await writeFile(file, buf);
  return buf;
}
await png(files["brand/og.svg"], 1200, 630, join(brandOut, "og.png"), C.ink);
const iconSvg = (pad) =>
  svg(64, 64, `<rect width="64" height="64" fill="${C.ink}"/><g transform="translate(${pad} ${pad}) scale(${(64 - 2 * pad) / 64})">${mark(C.paper, C.tally)}</g>`);
await png(iconSvg(10), 180, 180, join(out, "apple-touch-icon.png"), C.ink);
await png(iconSvg(8), 192, 192, join(out, "icon-192.png"), C.ink);
await png(iconSvg(8), 512, 512, join(out, "icon-512.png"), C.ink);
// multi-size ICO with PNG payloads
const sizes = [16, 32, 48];
const pngs = [];
for (const n of sizes) pngs.push(await png(files["favicon.svg"], n, n, null));
const head = Buffer.alloc(6 + 16 * sizes.length);
head.writeUInt16LE(0, 0);
head.writeUInt16LE(1, 2);
head.writeUInt16LE(sizes.length, 4);
let offset = head.length;
sizes.forEach((n, i) => {
  const o = 6 + i * 16;
  head.writeUInt8(n, o);
  head.writeUInt8(n, o + 1);
  head.writeUInt16LE(1, o + 4);
  head.writeUInt16LE(32, o + 6);
  head.writeUInt32LE(pngs[i].length, o + 8);
  head.writeUInt32LE(offset, o + 12);
  offset += pngs[i].length;
});
await writeFile(join(out, "favicon.ico"), Buffer.concat([head, ...pngs]));
await writeFile(
  join(out, "site.webmanifest"),
  JSON.stringify(
    {
      name: "electron-cast",
      short_name: "electron-cast",
      icons: [
        { src: "icon-192.png", sizes: "192x192", type: "image/png" },
        { src: "icon-512.png", sizes: "512x512", type: "image/png" },
      ],
      theme_color: C.ink,
      background_color: C.ink,
      display: "browser",
    },
    null,
    2,
  ),
);
await browser.close();
console.log("brand assets written to", out);
