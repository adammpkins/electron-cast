<script setup lang="ts">
// One requestSession(), hop by hop. Every hop is listed in the page; the button only lights them up in order.
import { onBeforeUnmount, ref } from "vue";
import { ExternalLink, Play, RotateCcw } from "lucide-vue-next";
import Button from "./ui/Button.vue";
import TraceReplay from "./TraceReplay.vue";

const CHROMIUM = "https://source.chromium.org/chromium/chromium/src/+/main:";
const hops = [
  {
    where: "Your page",
    title: "Google's SDK asks",
    body: "cast_sender.js is Google's, untouched. It calls PresentationRequest.start() the way it does in Chrome.",
    mirrors: [] as string[],
  },
  {
    where: "Your page, main world",
    title: "A stand-in answers",
    body: "electron-cast gives the page a Presentation API with the same shape as Chrome's, backed by the main process.",
    mirrors: [] as string[],
  },
  {
    where: "Preload, then IPC",
    title: "The bridge checks for a click",
    body: "The preload reads navigator.userActivation.isActive and passes the request across contextBridge. No click, no cast.",
    mirrors: ["content/browser/presentation/presentation_service_impl.cc"],
  },
  {
    where: "Main process",
    title: "Your app decides",
    body: "allowOrigin says whether this page may cast. selectDevice shows your picker, kept up to date while it is open.",
    mirrors: ["chrome/browser/ui/media_router/media_router_ui.cc", "chrome/browser/ui/media_router/query_result_manager.cc"],
  },
  {
    where: "Main process, network",
    title: "Find the TV, then check it is one",
    body: "mDNS finds devices on every interface, IPv6 included. Before CONNECT the device must prove it is Google-certified.",
    mirrors: [
      "components/media_router/common/providers/cast/channel/cast_auth_util.cc",
      "components/media_router/common/providers/cast/certificate/cast_cert_validator.cc",
    ],
  },
  {
    where: "Cast v2 over TLS",
    title: "The session opens",
    body: "CONNECT, LAUNCH, then the receiver app runs. The SDK's messages are translated to and from Cast v2 on the way.",
    mirrors: [
      "chrome/browser/media/router/providers/cast/cast_activity_manager.cc",
      "chrome/browser/media/router/providers/cast/cast_internal_message_util.cc",
    ],
  },
];

const blocks = ["SDK", "STAND-IN", "PRELOAD", "MAIN", "NETWORK", "CAST V2", "TV"];
const active = ref(-1);
const playing = ref(false);
let timer: ReturnType<typeof setTimeout> | undefined;
const reduced = () => typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

function step() {
  if (active.value >= hops.length) {
    playing.value = false;
    return;
  }
  active.value++;
  timer = setTimeout(step, 1100);
}
function send() {
  clearTimeout(timer);
  active.value = -1;
  playing.value = true;
  step();
}
function press() {
  if (reduced()) {
    // no animation: each press moves one hop
    active.value = active.value >= hops.length ? 0 : active.value + 1;
    return;
  }
  send();
}
// the recorded replay drives the same diagram: its frames light the network, session and TV boxes
function onTrace(hop: number) {
  clearTimeout(timer);
  playing.value = false;
  active.value = hop;
}
function reset() {
  clearTimeout(timer);
  playing.value = false;
  active.value = -1;
}
onBeforeUnmount(() => clearTimeout(timer));
</script>

<template>
  <div class="journey">
    <div class="jbar">
      <Button variant="signal" :disabled="playing" @click="press">
        <Play aria-hidden="true" />
        {{ active >= 0 && !playing && reduced() ? "Next hop" : "Send requestSession()" }}
      </Button>
      <Button v-if="active >= 0" variant="ghost" class="jreset" @click="reset"><RotateCcw aria-hidden="true" /> Reset</Button>
    </div>
    <ol class="flow" aria-hidden="true">
      <li v-for="(b, i) in blocks" :key="b" :class="{ on: i === active, done: i < active }"><span class="lamp" />{{ b }}</li>
    </ol>
    <TraceReplay @hop="onTrace" />
    <ol class="hops">
      <li v-for="(h, i) in hops" :key="h.title" class="hop" :class="{ on: i === active, done: i < active }" >
        <span class="px" aria-hidden="true" />
        <div class="hb">
          <p class="where">{{ h.where }}</p>
          <h3>{{ h.title }}</h3>
          <p class="what">{{ h.body }}</p>
          <ul v-if="h.mirrors.length" class="mirrors" aria-label="Chromium source this mirrors">
            <li v-for="m in h.mirrors" :key="m">
              <a :href="CHROMIUM + m" rel="noopener" target="_blank"><code>{{ m }}</code><ExternalLink aria-hidden="true" /></a>
            </li>
          </ul>
        </div>
      </li>
      <li class="hop tvhop" :class="{ on: active === hops.length }">
        <span class="px" aria-hidden="true" />
        <div class="hb"><p class="where">The TV</p><h3>The receiver app starts and your video plays</h3></div>
      </li>
    </ol>
  </div>
</template>

<style scoped>
.jbar { display: flex; gap: 0.5rem; margin-bottom: 1.6rem; }
.jreset { color: inherit; }
/* block diagram: boxes, arrows, mono labels. The tally lamp lights where the request is. */
.flow { list-style: none; margin: 0 0 2.2rem; padding: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(5.6rem, 1fr)); gap: 0.9rem 1.5rem; }
.flow li { white-space: nowrap; position: relative; margin: 0 !important; border: 2px solid #f4f1ea; padding: 0.55rem 0.6rem 0.5rem; font-family: var(--ec-mono); font-size: 0.72rem; color: #a29d92; display: flex; gap: 0.5rem; align-items: center; }
.flow li::after { content: ""; position: absolute; right: -1.5rem; top: 50%; width: 1.5rem; height: 2px; background: #f4f1ea; opacity: 0.5; }
.flow li:last-child::after { display: none; }
.flow li.done { color: #f4f1ea; }
.flow li.on { color: #f4f1ea; border-color: #ff4a1c; }
.lamp { width: 9px; height: 9px; flex: none; background: #4a463d; }
.flow li.done .lamp { background: #f4f1ea; }
.flow li.on .lamp { background: #ff4a1c; }
@media (max-width: 640px) { .flow { grid-template-columns: 1fr; gap: 0.5rem; } .flow li::after { display: none; } }
.hops { list-style: none; margin: 0; padding: 0; border-top: 1px solid #4a463d; }
.hop { position: relative; display: grid; grid-template-columns: 28px 1fr; gap: 1rem; padding: 1.1rem 0; margin: 0 !important; border-bottom: 1px solid #4a463d; }
.px { width: 14px; height: 14px; background: #4a463d; margin-top: 0.3rem; align-self: start; }
.hop.done .px { background: #f4f1ea; }
.hop.on .px { background: #ff4a1c; }
.hb { padding-top: 0.1rem; }
.where { margin: 0 !important; font-size: 0.74rem; color: #a29d92; font-family: var(--ec-mono); }
h3 { margin: 0.2rem 0 0.35rem !important; font-family: var(--ec-display); font-variation-settings: "wdth" 80; font-weight: 800; font-size: 1.45rem; color: #f4f1ea; letter-spacing: 0; }
.what { margin: 0 !important; color: #d9d4c7; max-width: 62ch; line-height: 1.6; }
.mirrors { list-style: none; padding: 0; margin: 0.7rem 0 0 !important; display: grid; gap: 0.25rem; }
.mirrors li { margin: 0 !important; }
.mirrors a { display: inline-flex; gap: 0.4rem; align-items: center; color: #ff8a68; text-decoration: none; font-size: 0.76rem; overflow-wrap: anywhere; }
.mirrors a:hover code { text-decoration: underline; }
.mirrors code { font-family: var(--ec-mono); background: none !important; color: inherit !important; padding: 0 !important; font-size: inherit !important; }
.mirrors svg { width: 12px; height: 12px; flex: none; }
.hop.on .where { color: #f4f1ea; }
@media (prefers-reduced-motion: reduce) { .px, .lamp { transition: none; } }
</style>
