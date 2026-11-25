<script setup lang="ts">
// The hero's picture: a TV that is NO SIGNAL until the recorded Cast v2 session (the same data the signal-path replay uses)
// reaches PLAYING, then ON AIR. Slates only: no video and no frames of it. Under reduced motion it is one still, ON AIR.
import { onBeforeUnmount, onMounted } from "vue";
import { Pause, Play } from "lucide-vue-next";
import { stillAt, useTrace } from "../trace";

let loop: ReturnType<typeof setTimeout> | undefined;
const tr = useTrace({
  initial: stillAt,
  onEnd: () => {
    loop = setTimeout(() => {
      tr.reset();
      tr.play();
    }, 3800);
  },
});
const { status, playing, reduced, ready } = tr;

onMounted(() => {
  tr.detectMotion();
  ready.value = true;
  if (!tr.reduced.value) {
    tr.cursor.value = 0;
    tr.play();
  }
});
function toggle() {
  clearTimeout(loop);
  if (tr.playing.value) tr.pause();
  else {
    if (tr.cursor.value >= 1 && tr.status.value.tail === "CLOSE") tr.cursor.value = 0;
    tr.play();
  }
}
onBeforeUnmount(() => clearTimeout(loop));
</script>

<template>
  <figure class="htv" :data-live="status.live">
    <div class="screen" role="img" :aria-label="status.live ? 'A television, on air.' : 'A television showing a NO SIGNAL test card.'">
      <div class="card"><i /><i /><i /><i /><i /><i /></div>
      <p v-if="!status.live" class="plate"><span class="lamp" />NO SIGNAL</p>
      <div v-else class="slate"><span class="dot" /><b>ON AIR</b></div>
    </div>
    <figcaption class="strip">
      <template v-if="status.last">
        <span>SRC {{ status.route }}</span><span v-if="status.app">APP {{ status.app }}</span><span>{{ status.tail }}</span>
      </template>
      <span v-else>NO SIGNAL | waiting for a cast</span>
    </figcaption>
    <button v-if="ready && !reduced" type="button" class="ctl" :aria-pressed="!playing" @click="toggle">
      <component :is="playing ? Pause : Play" aria-hidden="true" />{{ playing ? "Pause the recording" : "Replay the recording" }}
    </button>
  </figure>
</template>

<style scoped>
.htv { margin: 0; width: 100%; }
.screen { position: relative; aspect-ratio: 16 / 9; border: 2px solid var(--ec-ink); background: #15130f; overflow: hidden; box-shadow: 1px 1px 0 var(--ec-ink); }
.card { position: absolute; inset: 0; display: grid; grid-template-columns: repeat(6, 1fr); }
.card i { display: block; height: 100%; }
.card i:nth-child(1) { background: #8c8a85; } .card i:nth-child(2) { background: #74726d; } .card i:nth-child(3) { background: #5d5b57; }
.card i:nth-child(4) { background: #46443f; } .card i:nth-child(5) { background: #2f2d2a; } .card i:nth-child(6) { background: #1d1b18; }
.plate { position: absolute; left: 0; bottom: 0; margin: 0 !important; display: flex; gap: 0.7rem; align-items: center; padding: 0.7rem 1rem; background: #15130f; color: #f4f1ea; font-family: var(--ec-mono); font-size: 0.95rem; letter-spacing: 0.1em; }
.lamp { width: 11px; height: 11px; border: 2px solid #a29d92; box-sizing: border-box; display: inline-block; }
.slate { position: absolute; inset: 0; background: #15130f; color: #f4f1ea; display: flex; align-items: center; justify-content: center; gap: 1rem; }
.slate b { font-family: var(--ec-display); font-variation-settings: "wdth" 70; font-weight: 850; font-size: clamp(2rem, 6vw, 3.6rem); letter-spacing: 0.04em; }
.dot { width: clamp(16px, 3vw, 28px); aspect-ratio: 1; background: #ff4a1c; display: inline-block; }
.strip { display: flex; flex-wrap: wrap; gap: 0.2rem 0; padding: 0.65rem 0.9rem; background: #15130f; color: #f4f1ea; font-family: var(--ec-mono); font-size: 0.76rem; min-height: 2.6rem; align-items: center; margin-top: 2px; }
.strip span + span::before { content: "|"; margin: 0 0.7rem; color: #a29d92; }
.ctl { margin-top: 0.7rem; display: inline-flex; gap: 0.5rem; align-items: center; min-height: 2.4rem; padding: 0 0.9rem; background: none; border: 2px solid var(--ec-ink); color: var(--ec-ink); font-family: var(--ec-mono); font-size: 0.75rem; cursor: pointer; border-radius: 0; }
.ctl svg { width: 14px; height: 14px; }
.ctl:hover { background: var(--ec-ink); color: var(--ec-bg); }
</style>
