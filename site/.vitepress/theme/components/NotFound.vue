<script setup lang="ts">
// The 404 is the test card: the missing path is the channel that has no signal.
import { useData, withBase } from "vitepress";
import { computed } from "vue";
import Button from "./ui/Button.vue";
const { site } = useData();
const path = computed(() => (typeof location === "undefined" ? "/" : location.pathname.replace(site.value.base.replace(/\/$/, ""), "") || "/"));
</script>

<template>
  <main class="nf">
    <img class="logo lg-light" :src="withBase('/brand/lockup.svg')" alt="electron-cast" />
    <img class="logo lg-dark" :src="withBase('/brand/lockup-on-dark.svg')" alt="" aria-hidden="true" />
    <div class="card" aria-hidden="true"><i /><i /><i /><i /><i /><i /></div>
    <p class="code">404 <span class="lamp" aria-hidden="true" />NO SIGNAL</p>
    <p class="chan">{{ path }}</p>
    <p class="msg">CHANNEL NOT FOUND</p>
    <p class="go"><Button as="a" :href="withBase('/overview')">Back to the docs</Button></p>
  </main>
</template>

<style scoped>
.nf { max-width: 40rem; margin: 0 auto; padding: 4rem 24px 6rem; text-align: left; font-family: var(--ec-mono); }
.logo { height: 26px; width: auto; margin-bottom: 2rem; }
.lg-dark { display: none; }
:global(html.dark .nf .lg-light) { display: none; }
:global(html.dark .nf .lg-dark) { display: block; }
.card { display: grid; grid-template-columns: repeat(6, 1fr); height: 8rem; border: 2px solid var(--ec-ink); }
.card i:nth-child(1) { background: #8c8a85; } .card i:nth-child(2) { background: #74726d; } .card i:nth-child(3) { background: #5d5b57; }
.card i:nth-child(4) { background: #46443f; } .card i:nth-child(5) { background: #2f2d2a; } .card i:nth-child(6) { background: #1d1b18; }
.code { margin: 1.4rem 0 0.3rem; font-size: 1.6rem; letter-spacing: 0.06em; display: flex; align-items: center; gap: 0.7rem; color: var(--ec-ink); }
.lamp { width: 12px; height: 12px; background: var(--ec-bg); border: 2px solid var(--ec-ink); display: inline-block; }
.chan { margin: 0 0 0.3rem; font-size: 1.05rem; color: var(--ec-ink); overflow-wrap: anywhere; }
.msg { margin: 0 0 2rem; font-size: 0.85rem; letter-spacing: 0.08em; color: var(--ec-muted); }
.go { margin: 0; }
</style>
