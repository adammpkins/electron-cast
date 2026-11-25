<script setup lang="ts">
// Renders a ```mermaid fence. The source is in the page as a <pre> (readable without JavaScript); mermaid is loaded
// on demand and replaces it, following the light/dark switch.
import { computed, onMounted, ref, watch } from "vue";
import { useData } from "vitepress";

const props = defineProps<{ code: string }>();
const source = computed(() => decodeURIComponent(props.code));
const { isDark } = useData();
const svg = ref("");
const failed = ref(false);
let n = 0;

async function draw() {
  try {
    const mermaid = (await import("mermaid")).default;
    const dark = isDark.value;
    const css = getComputedStyle(document.documentElement);
    const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: "base",
      fontFamily: "Archivo Variable, system-ui, sans-serif",
      // Nodes are ink hairlines; the tally outline is for the one node an author marks with :::key
      themeCSS: `.node rect, .node polygon, .node circle, .node ellipse { stroke-width: 1px; }
        .node.key rect, .node.key polygon, .node.key circle, .node.key ellipse { stroke: ${v("--ec-tally", "#FF4A1C")} !important; stroke-width: 3px; }`,
      themeVariables: {
        darkMode: dark,
        background: "transparent",
        primaryColor: v("--ec-surface", dark ? "#151C21" : "#E8EBEA"),
        primaryTextColor: v("--ec-ink", dark ? "#E8ECEE" : "#0E1317"),
        primaryBorderColor: v("--ec-ink", "#15130F"),
        lineColor: v("--ec-muted", "#4A565E"),
        secondaryColor: v("--ec-bg", dark ? "#0E1317" : "#F1F3F2"),
        tertiaryColor: v("--ec-bg", dark ? "#0E1317" : "#F1F3F2"),
      },
    });
    const res = await mermaid.render(`ec-mermaid-${Math.random().toString(36).slice(2)}-${n++}`, source.value);
    svg.value = res.svg;
    failed.value = false;
  } catch {
    failed.value = true;
  }
}
onMounted(draw);
watch(isDark, draw);
</script>

<template>
  <figure class="ec-mermaid" :data-ready="!!svg && !failed">
    <div v-if="svg && !failed" class="ec-mermaid-svg" role="img" aria-label="Diagram" v-html="svg" />
    <pre v-else class="ec-mermaid-src"><code>{{ source }}</code></pre>
  </figure>
</template>
