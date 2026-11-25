<script setup lang="ts">
import { ref } from "vue";
import { withBase } from "vitepress";
import { Check, Copy, ExternalLink } from "lucide-vue-next";
import Button from "./ui/Button.vue";
import Tabs from "./ui/Tabs.vue";
import HeroTV from "./HeroTV.vue";
import Journey from "./Journey.vue";
import ParityTable from "./ParityTable.vue";

const copied = ref(false);
async function copy() {
  try {
    await navigator.clipboard.writeText("npm install electron-cast");
    copied.value = true;
    setTimeout(() => (copied.value = false), 1600);
  } catch {
    /* clipboard blocked: the command is selectable text */
  }
}
const tabs = [
  { id: "main", label: "main.ts" },
  { id: "preload", label: "preload.ts" },
  { id: "page", label: "page.js" },
];
</script>

<template>
  <main class="ec-landing">
    <!-- hero -->
    <header class="hero">
      <div class="wrap hero-grid">
        <div class="hero-copy">
          <h1>Chromecast for Electron.</h1>
          <p class="lede">
            Electron ships the Presentation API but nothing behind it, so Google's Cast SDK looks for TVs and finds none.
            electron-cast is the missing part. Your page keeps Google's own SDK, untouched, and its cast button works.
          </p>
          <div class="install">
            <code class="cmd"><span aria-hidden="true">$</span> npm install electron-cast</code>
            <Button variant="ghost" size="icon" :aria-label="copied ? 'Copied' : 'Copy the install command'" @click="copy">
              <Check v-if="copied" aria-hidden="true" /><Copy v-else aria-hidden="true" />
            </Button>
          </div>
          <p class="actions">
            <Button as="a" :href="withBase('/overview')">Read the docs</Button>
            <a class="plain" href="https://github.com/adammpkins/electron-cast" rel="noopener">Source on GitHub <ExternalLink aria-hidden="true" /></a>
          </p>
          <p class="facts">
            No native modules. No runtime dependencies. Works with <code>sandbox: true</code> and <code>contextIsolation: true</code>.
            Electron 35 or later.
          </p>
        </div>
        <HeroTV />
      </div>
    </header>

    <!-- why -->
    <section class="band why">
      <div class="wrap sec">
        <div class="rail"><span class="num">01</span><span class="lbl">The gap</span></div>
        <h2>Electron never got Chrome's Media Router.</h2>
        <div class="prose">
          <p>
            Chrome's Cast support is Google's JavaScript SDK on top of a browser feature: the Media Router. Electron's build of
            Chromium leaves the router out, so the SDK has nothing to talk to. People have asked for it since
            <a href="https://github.com/electron/electron/issues/869" rel="noopener">electron/electron#869</a>. It was opened in 2014 and closed in January 2025 as not planned: the maintainers said they
            are not planning the work, and welcomed a contribution.<span class="sidenote"><span class="sn-k">Source</span> Issue 869 on electron/electron, "Chromecast". Closed as not planned, 17 January 2025.</span>
          </p>
          <p>
            So electron-cast builds the router's parts from scratch: a stand-in Presentation API in the page, and in the main
            process device discovery, device authentication and the Cast v2 channel. Each rule is tied to Chromium source,
            and the page never knows the difference.
          </p>
        </div>
      </div>
    </section>

    <!-- setup -->
    <section class="band">
      <div class="wrap sec">
        <div class="rail"><span class="num">02</span><span class="lbl">Setup</span></div>
        <div class="lead">
          <h2>Three files. The page changes nothing.</h2>
          <p class="side">
            Make one cast manager in the main process, install the bridge in the preload, and load Google's SDK in the page the
            way you always have. The page's cast button now drives sessions through IPC.
          </p>
          <p class="side">
            Pass <code>ipcMain</code>, <code>contextBridge</code> and <code>ipcRenderer</code> in: the library never imports
            Electron. The preload has to be bundled; the <a :href="withBase('/example-app')">example app</a> shows how.
          </p>
        </div>
        <Tabs :tabs="tabs" label="The three files you touch">
          <template #main><slot name="main" /></template>
          <template #preload><slot name="preload" /></template>
          <template #page><slot name="page" /></template>
        </Tabs>
      </div>
    </section>

    <!-- one cast, hop by hop -->
    <section class="band receiver" aria-labelledby="journey-h">
      <div class="wrap sec">
        <div class="rail"><span class="num">03</span><span class="lbl">Signal path</span></div>
        <div class="jintro">
          <h2 id="journey-h">One requestSession(), hop by hop.</h2>
          <p class="side">
            Send a request and watch it cross each hop, then replay a recorded Cast v2 session frame by frame. Each hop says what runs
            there, and links to the Chromium file whose behaviour it copies.
          </p>
        </div>
        <Journey />
      </div>
    </section>

    <!-- parity -->
    <section class="band">
      <div class="wrap sec">
        <div class="rail"><span class="num">04</span><span class="lbl">Parity</span></div>
        <h2>As Chrome does it.</h2>
        <p class="side wide">
          The goal is not a Cast library that works. It is one that behaves like Chrome where Chrome's behaviour is known, and says
          so where it differs.
        </p>
        <ParityTable />
      </div>
    </section>

    <!-- what is tested -->
    <section class="band tested">
      <div class="wrap sec">
        <div class="rail"><span class="num">05</span><span class="lbl">Status</span></div>
        <h2>What is tested, and what is not.</h2>
        <p class="side wide">
          Eight real devices on a home network: a Chromecast, a Chromecast Ultra, a Google Home Mini (audio only), a Nest Hub, a
          Nest Hub Max and two Cast groups. CI also loads the built package in a real Electron 35, 40 and the latest stable on Linux,
          Windows and macOS, with a fake device.
        </p>
        <div class="tablewrap">
          <table>
            <caption class="sr">Test coverage by operating system</caption>
            <thead>
              <tr><th scope="col" /><th scope="col">Windows</th><th scope="col">Linux (Ubuntu on WSL2)</th><th scope="col">macOS</th></tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">Discovery and device authentication</th>
                <td>Device authentication passed on all 8</td>
                <td>Discovery and device authentication passed on all 8</td>
                <td class="no">Not tested</td>
              </tr>
              <tr>
                <th scope="row">Casting end to end: session, playback, restart rejoin, stop</th>
                <td>Tested, in a shipping Electron app</td>
                <td>Tested, in a shipping Electron app (dev and packaged builds)</td>
                <td class="no">Not tested</td>
              </tr>
              <tr>
                <th scope="row">IPv6 (discovery, TLS and device authentication)</th>
                <td>Tested on real devices, over unique-local and link-local addresses</td>
                <td class="no">Not tested</td>
                <td class="no">Not tested</td>
              </tr>
              <tr>
                <th scope="row">Casting from iframes</th>
                <td colspan="3">Unit tests only. No real device has been through it yet.</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="gaps">
          <div>
            <h3>Coming</h3>
            <ul>
              <li>DIAL devices</li>
              <li>Casting started from the app's own UI</li>
              <li>Live tracking of sessions started on other devices</li>
              <li>Mirroring a tab or the desktop</li>
              <li>Presenting to a second display</li>
            </ul>
          </div>
          <div>
            <h3>Not done</h3>
            <ul>
              <li>The Remote Playback API (needs support inside Electron)</li>
            </ul>
          </div>
        </div>
      </div>
    </section>

    <!-- next -->
    <section class="band next">
      <div class="wrap sec">
        <div class="rail"><span class="num">06</span><span class="lbl">Index</span></div>
        <h2>Where to next.</h2>
        <ul class="links">
          <li><a :href="withBase('/overview')">Overview</a><span>Install, setup, device authentication, what works.</span></li>
          <li><a :href="withBase('/docs/api')">API reference</a><span>Every option, type and error.</span></li>
          <li><a :href="withBase('/docs/main-api')">Main-process API</a><span>Observe devices and sessions; build a live picker.</span></li>
          <li><a :href="withBase('/docs/design')">How it works</a><span>The layers, and where we differ from Chromium.</span></li>
          <li><a :href="withBase('/changelog')">Changelog</a><span>0.4.0 added device authentication, iframes and restart rejoin.</span></li>
        </ul>
      </div>
    </section>
  </main>
</template>

<style scoped>
.ec-landing { color: var(--ec-ink); font-family: var(--ec-display); font-variation-settings: "wdth" 100; }
.wrap { max-width: 1200px; margin: 0 auto; padding: 0 24px; }
@media (min-width: 960px) { .wrap { padding: 0 48px; } }

/* hero: the test-card grid behind the headline */
.hero { position: relative; background-image: linear-gradient(var(--ec-grid) 1px, transparent 1px), linear-gradient(90deg, var(--ec-grid) 1px, transparent 1px); background-size: 40px 40px; background-position: -1px -1px; }
.hero-grid { display: grid; gap: 3rem; padding-top: 3.2rem; padding-bottom: 4rem; align-items: start; }
@media (min-width: 1000px) { .hero-grid { grid-template-columns: minmax(0, 1.1fr) minmax(0, 0.9fr); gap: 4rem; padding-top: 4.5rem; padding-bottom: 5rem; align-items: center; } }
.ec-landing .hero-copy h1 { font-family: var(--ec-display); font-weight: 850; font-variation-settings: "wdth" 70; font-size: clamp(3.2rem, 11vw, 6.4rem); line-height: 0.92; letter-spacing: -0.01em; margin: 0 0 1.6rem; max-width: 8em; overflow-wrap: normal; text-wrap: balance; }
.lede { font-size: clamp(1.12rem, 2vw, 1.34rem); line-height: 1.55; max-width: 36em; margin: 0 0 1.8rem; }
.install { display: inline-flex; align-items: center; border: 2px solid var(--ec-ink); background: var(--ec-bg); }
.cmd { font-family: var(--ec-mono); font-size: 0.95rem; padding: 0.55rem 0.9rem; background: none; color: var(--ec-ink); }
.cmd span { color: var(--ec-signal); margin-right: 0.35rem; }
.install :deep(.ec-btn) { border-left: 2px solid var(--ec-ink); height: 100%; min-height: 2.8rem; }
.actions { display: flex; flex-wrap: wrap; align-items: center; gap: 1.4rem; margin: 1.4rem 0 0; }
.plain { display: inline-flex; gap: 0.4rem; align-items: center; font-family: var(--ec-display); font-weight: 600; color: var(--ec-ink); text-decoration: underline !important; text-underline-offset: 4px; text-decoration-color: var(--ec-signal) !important; text-decoration-thickness: 2px !important; }
.plain svg { width: 14px; height: 14px; }
.facts { margin: 2rem 0 0; font-size: 0.95rem; color: var(--ec-muted); max-width: 40em; }
.facts code, .side code { font-family: var(--ec-mono); font-size: 0.85em; background: var(--vp-code-bg); padding: 0.1em 0.35em; color: var(--vp-code-color); }
.hero { border-bottom: 2px solid var(--ec-ink); }

/* bands */
.band { padding: clamp(64px, 8vw, 104px) 0; border-bottom: 1px solid var(--ec-line); }
.ec-landing .band h2 { font-family: var(--ec-display); font-weight: 800; font-variation-settings: "wdth" 76; font-size: clamp(2rem, 4vw, 3rem); line-height: 1; letter-spacing: -0.005em; margin: 0 0 1rem; text-wrap: balance; }
/* the manual grid: a rail with the section number, then the content; Chromium citations sit in the right margin on wide screens */
.sec { display: grid; gap: 1.2rem 3rem; position: relative; }
.rail { display: flex; gap: 0.8rem; align-items: baseline; font-family: var(--ec-mono); font-size: 0.8rem; color: var(--ec-muted); }
.num { color: var(--ec-ink); font-size: 1.5rem; line-height: 1; }
@media (min-width: 1000px) {
  .sec { grid-template-columns: 9.5rem minmax(0, 1fr); }
  .rail { grid-column: 1; grid-row: 1 / span 6; flex-direction: column; gap: 0.3rem; position: sticky; top: 88px; align-self: start; border-top: 2px solid var(--ec-ink); padding-top: 0.6rem; }
  .sec > :not(.rail) { grid-column: 2; }
}
.sidenote { display: block; font-family: var(--ec-mono); font-size: 0.74rem; line-height: 1.5; color: var(--ec-muted); border-left: 2px solid var(--ec-tally); padding-left: 0.7rem; margin: 0.8rem 0 0; }
.sn-k { color: var(--ec-ink); margin-right: 0.4rem; }
@media (min-width: 1380px) {
  .prose p { position: relative; }
  .sidenote { position: absolute; left: calc(100% + 2rem); top: 0.2rem; width: 15rem; margin: 0; }
}
.prose p, .side { font-size: 1.1rem; line-height: 1.65; margin: 0 0 1rem; max-width: 40em; }
.prose a, .side a { color: var(--ec-signal); text-decoration: underline !important; text-underline-offset: 3px; }
.wide { max-width: 50em; margin-bottom: 2rem; }
.why { background: var(--vp-c-bg-soft); }
.receiver { background: #15130f; color: #f4f1ea; border-bottom: 0; }
.ec-landing .receiver h2 { color: #f4f1ea; }
.receiver .side { color: #cfc9bc; }
.receiver .num { color: #f4f1ea; }
.receiver .rail { color: #a29d92; border-top-color: #f4f1ea; }
.jintro { position: relative; }

/* setup tabs */
.band :deep(.ec-tabs) { border: 2px solid var(--ec-ink); min-width: 0; }
.band :deep(.ec-tabs-list) { border-bottom-width: 2px; background: var(--vp-c-bg-soft); }
.band :deep(.ec-tab-panel) { max-height: 34rem; overflow: auto; scrollbar-color: var(--ec-ink) transparent; }

/* tested */
.tablewrap { overflow-x: auto; border-top: 2px solid var(--ec-ink); border-bottom: 2px solid var(--ec-ink); margin-bottom: 2.5rem; }
table { width: 100%; border-collapse: collapse; min-width: 640px; font-size: 0.98rem; }
th, td { text-align: left; vertical-align: top; padding: 0.85rem 1rem 0.85rem 0.25rem; border-top: 1px solid var(--ec-line); line-height: 1.45; }
thead th { font-family: var(--ec-display); font-weight: 700; font-size: 0.85rem; border-top: 0; }
tbody th { font-weight: 600; width: 28%; }
td.no { color: var(--ec-muted); }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
.gaps { display: grid; gap: 2rem; }
@media (min-width: 700px) { .gaps { grid-template-columns: 1fr 1fr; } }
.gaps h3 { font-family: var(--ec-display); font-variation-settings: "wdth" 80; font-weight: 800; font-size: 1.25rem; margin: 0 0 0.5rem; }
.gaps ul { margin: 0; padding: 0; list-style: none; }
.gaps li { padding: 0.35rem 0 0.35rem 1.5rem; position: relative; }
.gaps li::before { content: ""; position: absolute; left: 0; top: 0.8rem; width: 9px; height: 9px; background: var(--ec-ink); }
.gaps div:last-child li::before { background: none; border: 2px solid var(--ec-muted); }

/* next */
.next { border-bottom: 0; }
.links { list-style: none; padding: 0; margin: 1.5rem 0 0; border-top: 2px solid var(--ec-ink); }
.links li { position: relative; display: grid; gap: 0.2rem 2rem; padding: 1rem 0.25rem 1rem 1rem; border-bottom: 1px solid var(--ec-line); }
.links li::before { content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 2px; background: transparent; }
.links li:hover::before, .links li:focus-within::before { background: var(--ec-tally); }
.links li:hover { background: var(--vp-c-bg-soft); }
.links a::after { content: ""; position: absolute; inset: 0; } /* the whole row is the link */
@media (min-width: 700px) { .links li { grid-template-columns: 16rem 1fr; align-items: baseline; } }
.links a { font-family: var(--ec-display); font-variation-settings: "wdth" 80; font-weight: 800; font-size: 1.4rem; color: var(--ec-ink); text-decoration: none; }
.links a:hover { color: var(--ec-signal); text-decoration: underline; }
.links span { color: var(--ec-muted); }
</style>
