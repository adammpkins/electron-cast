import { defineConfig } from "vitepress";
import tailwindcss from "@tailwindcss/vite";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// The docs are the repository's own Markdown (README.md, CHANGELOG.md, SECURITY.md, docs/**). The site reads them in
// place (srcDir is the repo root); nothing is copied. Add a file under docs/ and it appears in the sidebar.
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..");
const site = resolve(here, "..");
const REPO_URL = "https://github.com/adammpkins/electron-cast";
const SITE_URL = "https://adammpkins.github.io/electron-cast/";
const SITE_DESCRIPTION =
  "Chromecast for Electron. Google's own Cast SDK runs unchanged in your app; electron-cast supplies the Media Router Electron lacks.";

// pages whose source has no usable opening paragraph
const PAGE_DESCRIPTIONS: Record<string, string> = {
  "changelog.md": "Release notes for electron-cast: what each version added, changed and fixed.",
  "example-app.md": "A small Electron app that shows the recommended electron-cast setup: main process, preload bridge and a page that casts.",
};

/** The first plain-text paragraph after the title, trimmed to a search-snippet length. */
function firstParagraph(md: string): string {
  const body = md.replace(/^---[\s\S]*?---\s*/, "").replace(/<!--[\s\S]*?-->/g, "");
  for (const block of body.split(/\n\s*\n/)) {
    const t = block.trim();
    if (!t || /^(#|<|\||!|>|```|-|\*|\d+\.|\[!\[|:::)/.test(t)) continue;
    const plain = t.replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/[`*_]/g, "").replace(/\s+/g, " ").trim();
    if (plain.length < 40) continue;
    return plain.length <= 160 ? plain : plain.slice(0, 157).replace(/\s+\S*$/, "") + "...";
  }
  return "";
}

const SKIP_DIRS = new Set(["node_modules", ".git", ".github", "dist", "src", "test", "smoke", "tools", "scripts", "site"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const rel = relative(repo, full).split(sep).join("/");
    if (statSync(full).isDirectory()) {
      if (SKIP_DIRS.has(name) && dir === repo) continue;
      if (name === "node_modules") continue;
      walk(full, out);
    } else if (name.endsWith(".md")) out.push(rel);
  }
  return out;
}

// Source path -> served path. Landing and brand notes live in site/; everything else keeps its folder, lower-cased.
const SITE_PAGES: Record<string, string> = { "site/index.md": "index.md", "site/BRAND.md": "brand.md" };
const sources = [...walk(repo), ...Object.keys(SITE_PAGES).filter((p) => existsSync(join(repo, p)))];
const served = (src: string): string => {
  if (SITE_PAGES[src]) return SITE_PAGES[src];
  if (src === "README.md") return "overview.md";
  if (src === "examples/electron-app/README.md") return "example-app.md";
  return src.toLowerCase();
};
const rewrites: Record<string, string> = {};
for (const src of sources) rewrites[src] = served(src);
const urlOf = (src: string) => "/" + served(src).replace(/\.md$/, "");
const sourceSet = new Set(sources);
const sourceByLower = new Map(sources.map((s) => [s.toLowerCase(), s]));

const titleOf = (src: string): string => {
  const m = readFileSync(join(repo, src), "utf8").match(/^#\s+(.+)$/m);
  const t = (m?.[1] ?? src).replace(/`/g, "").trim();
  return t === "electron-cast" ? "Overview" : t.replace(/^electron-cast\s+/i, "").replace(/^./, (c) => c.toUpperCase());
};
const item = (src: string) => ({ text: titleOf(src), link: urlOf(src) });

// ---- sidebar: fixed order for the docs we know about, then anything new, grouped by folder
const ORDER = [
  "README.md",
  "docs/getting-started.md",
  "docs/troubleshooting.md",
  "docs/api.md",
  "docs/main-api.md",
  "docs/architecture.md",
  "docs/design.md",
];
const lower = (s: string) => s.toLowerCase();
const docs = sources.filter((s) => s.startsWith("docs/"));
const byOrder = (a: string, b: string) => {
  const ia = ORDER.indexOf(lower(a)), ib = ORDER.indexOf(lower(b));
  return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
};
const pick = (pred: (s: string) => boolean) => sources.filter(pred).sort(byOrder).map(item);
const groupsFromFolders = (): any[] => {
  const folders = new Map<string, string[]>();
  for (const d of docs) {
    const parts = d.split("/");
    if (parts.length > 2) folders.set(parts[1], [...(folders.get(parts[1]) ?? []), d]);
  }
  return [...folders].map(([name, list]) => ({
    text: name === "guides" ? "Guides" : name.replace(/[-_]/g, " ").replace(/^./, (c) => c.toUpperCase()),
    collapsed: false,
    items: list.sort(byOrder).map(item),
  }));
};
const top = (s: string) => docs.includes(s) && s.split("/").length === 2;
const START = ["README.md", ...ORDER.filter((o) => ["docs/getting-started.md", "docs/troubleshooting.md"].includes(o))];
const sidebar = [
  { text: "Start", items: sources.filter((s) => START.some((x) => lower(x) === lower(s))).sort(byOrder).map(item) },
  ...groupsFromFolders(),
  {
    text: "Reference",
    items: sources
      .filter((s) => top(s) && ["docs/api.md", "docs/main-api.md"].includes(lower(s)))
      .sort(byOrder)
      .map(item),
  },
  {
    text: "How it works",
    items: sources
      .filter((s) => top(s) && ["docs/architecture.md", "docs/design.md"].includes(lower(s)))
      .sort(byOrder)
      .map(item),
  },
  {
    text: "Project",
    items: [
      ...pick((s) => ["CHANGELOG.md", "SECURITY.md", "CONTRIBUTING.md"].includes(s)),
      ...pick((s) => s === "examples/electron-app/README.md"),
      ...pick((s) => s === "site/BRAND.md"),
    ],
  },
];
// docs/*.md the groups above do not name still show up
const named = new Set(sidebar.flatMap((g: any) => (g.items ?? []).map((i: any) => i.link)));
const extra = docs.filter((s) => top(s) && !named.has(urlOf(s))).sort(byOrder).map(item);
if (extra.length) sidebar.splice(sidebar.length - 1, 0, { text: "More docs", items: extra });

// ---- links in the repo's Markdown that point outside the site (source files, folders) go to GitHub
function githubLinks(md: any) {
  md.core.ruler.push("repo-links", (state: any) => {
    const from: string | undefined = state.env?.relativePath;
    if (!from) return;
    for (const block of state.tokens) {
      for (const tok of block.children ?? []) {
        if (tok.type !== "link_open") continue;
        const href = tok.attrGet("href");
        if (!href || /^([a-z][a-z0-9+.-]*:|#|\/)/i.test(href)) continue;
        const [path, hash] = href.split("#");
        if (!path) continue;
        const target = posix.normalize(posix.join(posix.dirname(from), decodeURIComponent(path)));
        if (target.startsWith("..")) continue;
        // a link to a page of the site: point at the served (lower-case) URL, so it also resolves on a case-sensitive host
        const page = sourceByLower.get(lower(target));
        if (page) {
          tok.attrSet("href", urlOf(page) + (hash ? "#" + hash : ""));
          continue;
        }
        const abs = join(repo, target);
        if (!existsSync(abs)) continue;
        const kind = statSync(abs).isDirectory() ? "tree" : "blob";
        tok.attrSet("href", `${REPO_URL}/${kind}/main/${target.replace(/\/$/, "")}${hash ? "#" + hash : ""}`);
      }
    }
  });
}

function landingCode(md: any) {
  md.core.ruler.push("landing-code", (state: any) => {
    if (!/(^|\/)index\.md$/.test(state.env?.relativePath ?? "")) return;
    for (const tok of state.tokens) if (tok.type === "fence") tok.content = reflowForLanding(tok.content);
  });
}

// The README opens with images under docs/readme/ for GitHub and npm; on the site they would be dead relative links, so the
// HTML blocks that carry them (and a <details> wrapping them) are left out of the page.
function readmeArt(md: any) {
  md.core.ruler.push("readme-art", (state: any) => {
    const t = state.tokens;
    const art = (x: any) => x.type === "html_block" && x.content.includes("docs/readme/");
    for (let i = 0; i < t.length; i++) {
      if (t[i].type !== "html_block") continue;
      if (/^\s*<details>/.test(t[i].content)) {
        let j = i;
        while (j < t.length && !(t[j].type === "html_block" && t[j].content.includes("</details>"))) j++;
        if (j < t.length && t.slice(i, j + 1).some(art)) for (let k = i; k <= j; k++) if (t[k].type === "html_block") t[k].content = "";
      } else if (art(t[i])) t[i].content = "";
    }
  });
}

// Landing-page code is shown narrower than the repo's own files (no horizontal scroll): long comments wrap, and the few long
// statements break the way a formatter would. Lines it does not know are left as they are.
const MAX_COLS = 88;
function reflowForLanding(code: string): string {
  const out: string[] = [];
  const lines = code.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length <= MAX_COLS) {
      out.push(line);
      continue;
    }
    const indent = /^\s*/.exec(line)![0];
    const text = line.trim();
    if (text.startsWith("//")) {
      let cur = indent + "//";
      for (const w of text.slice(2).trim().split(/\s+/)) {
        if ((cur + " " + w).length > MAX_COLS) { out.push(cur); cur = indent + "// " + w; } else cur += " " + w;
      }
      out.push(cur);
    } else if (/^const (\w+) = "(https:[^"]+)";$/.test(text)) {
      const m = /^const (\w+) = "(https:[^"]+)";$/.exec(text)!;
      out.push(`${indent}const ${m[1]} =`, `${indent}  "${m[2]}";`);
    } else if (/^(const \w+ = new [\w.]+)\((\w+), ("[^"]+")\);$/.test(text)) {
      const m = /^(const \w+ = new [\w.]+)\((\w+), ("[^"]+")\);$/.exec(text)!;
      out.push(`${indent}${m[1]}(`, `${indent}  ${m[2]},`, `${indent}  ${m[3]},`, `${indent});`);
    } else if (/^\w+\.addEventListener\(.+, \((\w+)\) => \{$/.test(text)) {
      const m = /^(\w+\.addEventListener)\((.+), (\(\w+\)) => \{$/.exec(text)!;
      out.push(`${indent}${m[1]}(`, `${indent}  ${m[2]},`, `${indent}  ${m[3]} => {`);
      let j = i + 1;
      for (; j < lines.length && lines[j] !== indent + "});"; j++) out.push(lines[j] ? "  " + lines[j] : lines[j]);
      out.push(`${indent}  },`, `${indent});`);
      i = j;
    } else if (/^devices\.map\(\((\w)\) => \(\{ (.+) \}\)\),$/.test(text)) {
      const m = /^devices\.map\(\((\w)\) => \(\{ (.+) \}\)\),$/.exec(text)!;
      out.push(`${indent}devices.map((${m[1]}) => ({`);
      for (const part of m[2].split(/, (?=\w+: )/)) out.push(`${indent}  ${part.replace(/,$/, "")},`);
      out.push(`${indent}})),`);
    } else out.push(line);
  }
  return out.join("\n");
}

// ```ts readme:<text> pulls the first fenced block of README.md that contains <text>, so landing-page code is the README's.
const readmeBlocks = [...readFileSync(join(repo, "README.md"), "utf8").matchAll(/```(\w+)\n([\s\S]*?)```/g)].map((m) => ({ lang: m[1], code: m[2] }));
function readmeSnippets(md: any) {
  md.core.ruler.push("readme-snippets", (state: any) => {
    for (const tok of state.tokens) {
      const m = tok.type === "fence" && /^(\w+)\s+readme:(.+)$/.exec(tok.info.trim());
      if (!m) continue;
      const hit = readmeBlocks.find((b) => b.code.includes(m[2]));
      if (!hit) throw new Error(`readme snippet not found: ${m[2]}`);
      tok.info = m[1];
      tok.content = hit.code;
    }
  });
}

export default defineConfig({
  lang: "en",
  title: "electron-cast",
  titleTemplate: ":title | electron-cast",
  transformPageData(pageData) {
    if (pageData.relativePath === "overview.md") pageData.title = "Overview";
    // every page gets its own description: frontmatter wins, else the first plain paragraph of the page
    if (!pageData.frontmatter.description && pageData.relativePath !== "index.md") {
      const d = PAGE_DESCRIPTIONS[pageData.relativePath] ?? firstParagraph(readFileSync(join(repo, (pageData as any).filePath ?? pageData.relativePath), "utf8"));
      if (d) pageData.frontmatter.description = pageData.description = d;
    }
  },
  sitemap: {
    hostname: SITE_URL,
    transformItems: (items) => items.filter((i) => !/404/.test(i.url)),
  },
  transformHead({ pageData }) {
    const rel = pageData.relativePath;
    const path = pageData.isNotFound ? "404" : rel.replace(/(^|\/)index\.md$/, "$1").replace(/\.md$/, "");
    const url = SITE_URL + path;
    const title = pageData.isNotFound ? "Not found" : pageData.title || "electron-cast";
    const desc: string = pageData.frontmatter.description || SITE_DESCRIPTION;
    const fullTitle = rel === "index.md" ? "electron-cast: Chromecast for Electron" : `${title} | electron-cast`;
    const head: any[] = [
      ["meta", { property: "og:title", content: fullTitle }],
      ["meta", { property: "og:description", content: desc }],
      ["meta", { property: "og:url", content: url }],
      ["meta", { name: "twitter:title", content: fullTitle }],
      ["meta", { name: "twitter:description", content: desc }],
    ];
    if (pageData.isNotFound) head.push(["meta", { name: "robots", content: "noindex" }]);
    else head.push(["link", { rel: "canonical", href: url }]);
    if (rel === "index.md") {
      head.push([
        "script",
        { type: "application/ld+json" },
        JSON.stringify({
          "@context": "https://schema.org",
          "@type": "SoftwareSourceCode",
          name: "electron-cast",
          description: SITE_DESCRIPTION,
          url: SITE_URL,
          codeRepository: "https://github.com/adammpkins/electron-cast",
          programmingLanguage: "TypeScript",
          license: "https://opensource.org/licenses/MIT",
          runtimePlatform: "Electron",
        }),
      ]);
    }
    return head;
  },
  description: SITE_DESCRIPTION,
  base: "/electron-cast/",
  srcDir: "..",
  srcExclude: [
    "**/node_modules/**",
    "src/**",
    "test/**",
    "smoke/**",
    "tools/**",
    "scripts/**",
    ".github/**",
    "dist/**",
    "site/.vitepress/**",
    "site/brand/**",
    "site/public/**",
  ],
  rewrites,
  cleanUrls: true,
  lastUpdated: false,
  appearance: true,
  head: [
    ["link", { rel: "icon", href: "/electron-cast/favicon.svg", type: "image/svg+xml" }],
    ["link", { rel: "icon", href: "/electron-cast/favicon.ico", sizes: "48x48" }],
    ["link", { rel: "apple-touch-icon", href: "/electron-cast/apple-touch-icon.png" }],
    ["link", { rel: "manifest", href: "/electron-cast/site.webmanifest" }],
    ["meta", { name: "theme-color", content: "#15130F" }],
    ["meta", { property: "og:type", content: "website" }],
    ["meta", { property: "og:site_name", content: "electron-cast" }],
    ["meta", { property: "og:image", content: SITE_URL + "brand/og.png" }],
    ["meta", { property: "og:image:width", content: "1200" }],
    ["meta", { property: "og:image:height", content: "630" }],
    ["meta", { property: "og:image:alt", content: "electron-cast: Chromecast for Electron" }],
    ["meta", { name: "twitter:card", content: "summary_large_image" }],
    ["meta", { name: "twitter:image", content: SITE_URL + "brand/og.png" }],
  ],
  markdown: {
    config(md) {
      githubLinks(md);
      readmeSnippets(md);
      readmeArt(md);
      landingCode(md);
      const fence = md.renderer.rules.fence!;
      md.renderer.rules.fence = (tokens, idx, options, env, self) => {
        const tok = tokens[idx];
        if (tok.info.trim() === "mermaid") return `<Mermaid code="${encodeURIComponent(tok.content)}" />`;
        return fence(tokens, idx, options, env, self);
      };
    },
    theme: { light: "github-light-high-contrast", dark: "github-dark-high-contrast" },
  },
  themeConfig: {
    logo: { light: "/brand/lockup.svg", dark: "/brand/lockup-on-dark.svg", alt: "electron-cast home" },
    siteTitle: false,
    nav: [
      { text: "Docs", link: "/overview", activeMatch: "^/(overview|example-app|docs/(?!api|main-api))" },
      { text: "API", link: "/docs/api", activeMatch: "^/docs/(api|main-api)" },
      { text: "Changelog", link: "/changelog" },
    ],
    sidebar,
    search: { provider: "local" },
    outline: { level: [2, 3], label: "On this page" },
    socialLinks: [
      { icon: "github", link: REPO_URL, ariaLabel: "electron-cast on GitHub" },
      { icon: "npm", link: "https://www.npmjs.com/package/electron-cast", ariaLabel: "electron-cast on npm" },
    ],
    editLink: { pattern: `${REPO_URL}/edit/main/:path`, text: "Edit this page on GitHub" },
    footer: { message: "MIT licensed. Not affiliated with Google or the Electron project.", copyright: "Adam Perkins" },
  },
  vite: {
    plugins: [tailwindcss()],
    publicDir: join(site, "public"),
    // srcDir is the repo root, which has no node_modules; pages there still need Vue's runtime.
    resolve: {
      alias: [
        { find: /^vue\/server-renderer$/, replacement: join(site, "node_modules/vue/server-renderer/index.mjs") },
        { find: /^vue$/, replacement: join(site, "node_modules/vue/dist/vue.runtime.esm-bundler.js") },
      ],
    },
    server: { fs: { allow: [repo] } },
  },
});
