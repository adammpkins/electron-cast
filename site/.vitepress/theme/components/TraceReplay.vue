<script setup lang="ts">
// A recorded Cast v2 session, replayed as a broadcast log. No SDK, no network, no device: it reads site/.vitepress/data/trace.json
// through ../trace.ts. Without JS the whole log is plain HTML; each frame is a <details> that opens its payload.
import { nextTick, onMounted, ref, watch } from "vue";
import { Pause, Play, RotateCcw, SkipBack, SkipForward } from "lucide-vue-next";
import { GAP, caption, clock, frames, gapBefore, gapLabel, hopOf, short, total, useTrace } from "../trace";

const emit = defineEmits<{ (e: "hop", hop: number): void }>();
// Rendered on the server and without JS the full log shows; once mounted it starts from the test card.
const { ready, cursor, playing, realTime, reduced, shown, last, status, say, play, next, prev, reset, scrub, toggle, detectMotion } = useTrace();
const logEl = ref<HTMLElement | null>(null);

watch(cursor, async () => {
  emit("hop", last.value ? hopOf(last.value) : -1);
  await nextTick();
  const el = logEl.value;
  if (el && ready.value) el.scrollTop = el.scrollHeight;
});
onMounted(() => {
  detectMotion();
  ready.value = true;
  cursor.value = 0;
});
const pretty = (p: unknown) => JSON.stringify(p, null, 2);
</script>

<template>
  <figure class="trace" aria-labelledby="trace-cap">
    <figcaption id="trace-cap" class="cap">
      {{ caption }} The video is Big Buck Bunny, &copy; Blender Foundation, CC BY 3.0. Nothing on this page talks to a device.
    </figcaption>

    <div v-if="ready" class="bar" role="group" aria-label="Replay controls">
      <button type="button" class="tb prime" :aria-pressed="playing" @click="toggle">
        <component :is="playing ? Pause : Play" aria-hidden="true" />{{ reduced ? "Step" : playing ? "Pause" : cursor >= total ? "Replay" : "Play" }}
      </button>
      <button type="button" class="tb" :disabled="cursor <= 0" @click="prev"><SkipBack aria-hidden="true" />Back</button>
      <button v-if="!reduced" type="button" class="tb" :disabled="cursor >= total" @click="next"><SkipForward aria-hidden="true" />Step</button>
      <button type="button" class="tb" :disabled="cursor === 0 && !playing" @click="reset"><RotateCcw aria-hidden="true" />Reset</button>
      <button v-if="!reduced" type="button" class="tb" :aria-pressed="realTime" @click="realTime = !realTime">Real time {{ realTime ? "on" : "off" }}</button>
      <label class="scrub">
        <span class="sr">Scrub through the recorded frames</span>
        <input type="range" min="0" :max="total" :value="cursor" :aria-valuetext="say" @input="scrub" />
      </label>
      <span class="count" aria-hidden="true">{{ cursor }}/{{ total }}</span>
    </div>

    <div class="screen" :data-live="status.live">
      <div v-if="ready && cursor === 0" class="idle" aria-hidden="true">
        <div class="card"><i /><i /><i /><i /><i /><i /></div>
        <p class="nosig"><span class="lamp" />NO SIGNAL <small>press play to replay a recorded session</small></p>
      </div>
      <ol ref="logEl" class="log" :class="{ hidden: ready && cursor === 0 }" aria-label="Recorded Cast v2 frames">
        <template v-for="(f, i) in ready ? shown : frames" :key="i">
        <li v-if="gapBefore(i) > GAP" class="gap"><span aria-hidden="true">{{ gapLabel(i) }}</span><span class="sr">{{ gapLabel(i) }} of silence</span>{{ realTime ? "" : " (shortened on replay)" }}</li>
        <li :class="[f.dir, { now: ready && i === cursor - 1 }]">
          <details>
            <summary>
              <span class="t">{{ clock(f.t) }}</span>
              <span class="arrow" aria-hidden="true">{{ f.dir === "out" ? "→" : "←" }}</span>
              <span class="sr">{{ f.dir === "out" ? "sent" : "received" }}</span>
              <span class="type">{{ f.type }}</span>
              <span class="ns">{{ short(f.namespace) }}</span>
              <span class="who">{{ f.source }} to {{ f.destination }}</span>
            </summary>
            <pre tabindex="0">{{ pretty(f.payload) }}</pre>
          </details>
        </li>
        </template>
      </ol>
      <p class="onair" :class="{ lit: status.live }"><span class="lamp" aria-hidden="true" />{{ status.live ? "ON AIR" : "OFF AIR" }}</p>
    </div>
    <p class="sr" role="status" aria-live="polite">{{ ready ? say : "" }}</p>
  </figure>
</template>

<style scoped>
.trace { margin: 0 0 2.4rem; padding: 0; color: #f4f1ea; }
.cap { font-size: 0.8rem; color: #a29d92; max-width: 62ch; margin-bottom: 0.9rem; line-height: 1.5; }
.gap { padding: 0.25rem 0.9rem; color: #a29d92; border-bottom: 1px dashed #2a2721 !important; font-size: 0.7rem; letter-spacing: 0.04em; }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.bar { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; margin-bottom: 0.9rem; }
.tb { display: inline-flex; align-items: center; gap: 0.5rem; min-height: 2.6rem; padding: 0 1.1rem; border: 2px solid #f4f1ea; background: none; color: #f4f1ea; font-family: var(--ec-mono); font-size: 0.78rem; cursor: pointer; border-radius: 0; }
.tb svg { width: 15px; height: 15px; }
.tb:hover:not(:disabled) { background: #f4f1ea; color: #15130f; }
.tb:disabled { opacity: 0.4; cursor: default; }
.tb.prime { background: #ff4a1c; border-color: #ff4a1c; color: #15130f; font-weight: 700; padding: 0 1.4rem; }
.tb.prime:hover { background: #f4f1ea; border-color: #f4f1ea; }
.scrub { flex: 1 1 10rem; min-width: 8rem; display: flex; }
.scrub input:focus-visible { outline: 2px solid #f4f1ea; outline-offset: 3px; }
.scrub input { width: 100%; accent-color: #ff4a1c; height: 2rem; }
.count { font-family: var(--ec-mono); font-size: 0.75rem; color: #a29d92; min-width: 3.4rem; text-align: right; }
.screen { position: relative; border: 2px solid #f4f1ea; background: #0d0c09; min-height: 17rem; }
.idle { position: absolute; inset: 0; display: grid; grid-template-rows: 1fr auto; }
.card { display: grid; grid-template-columns: repeat(6, 1fr); }
.card i { display: block; }
.card i:nth-child(1) { background: #8c8a85; } .card i:nth-child(2) { background: #74726d; } .card i:nth-child(3) { background: #5d5b57; }
.card i:nth-child(4) { background: #46443f; } .card i:nth-child(5) { background: #2f2d2a; } .card i:nth-child(6) { background: #1d1b18; }
.nosig { margin: 0 !important; padding: 0.9rem 1rem; background: #15130f; font-family: var(--ec-mono); font-size: 0.9rem; letter-spacing: 0.08em; display: flex; gap: 0.7rem; align-items: center; flex-wrap: wrap; }
.nosig small { font-size: 0.72rem; letter-spacing: 0; color: #a29d92; }
.lamp { width: 10px; height: 10px; flex: none; background: #4a463d; border: 1px solid #a29d92; display: inline-block; }
.log { list-style: none; margin: 0; padding: 0.4rem 0 2.6rem; max-height: 24rem; overflow-y: auto; font-family: var(--ec-mono); font-size: 0.76rem; }
.log.hidden { visibility: hidden; max-height: 17rem; }
.log li { margin: 0 !important; border-bottom: 1px solid #2a2721; }
.log details { margin: 0 !important; padding: 0 !important; border: 0 !important; background: none !important; border-radius: 0 !important; }
summary { line-height: 1.4; display: flex; flex-wrap: wrap; gap: 0.2rem 0.8rem; align-items: baseline; padding: 0.5rem 0.9rem; cursor: pointer; list-style: none; }
summary::-webkit-details-marker { display: none; }
summary:hover { background: #1d1a15; }
.t { color: #a29d92; min-width: 5.4rem; }
.arrow { width: 1.2rem; color: #a29d92; }
.out .arrow { color: #f4f1ea; }
.in .arrow { color: #ff6b47; }
.type { font-weight: 700; color: #f4f1ea; min-width: 8.5rem; }
.ns { color: #d9d4c7; }
.who { color: #a29d92; }
.log li.now summary { background: #26231d; box-shadow: inset 3px 0 0 #ff4a1c; }
details[open] summary { background: #1d1a15; }
pre { margin: 0; padding: 0.6rem 0.9rem 0.8rem 2.6rem; overflow-x: auto; color: #d9d4c7; background: #15130f; font-size: 0.74rem; line-height: 1.5; }
.onair { position: absolute; right: 0.7rem; bottom: 0.6rem; margin: 0 !important; display: flex; gap: 0.5rem; align-items: center; font-family: var(--ec-mono); font-size: 0.72rem; letter-spacing: 0.08em; color: #a29d92; background: #0d0c09; padding: 0.2rem 0.5rem; }
.onair.lit { color: #f4f1ea; }
.onair.lit .lamp { background: #ff4a1c; border-color: #ff4a1c; }
</style>
