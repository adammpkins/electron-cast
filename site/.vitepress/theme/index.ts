import { h } from "vue";
import DefaultTheme from "vitepress/theme";
import type { Theme } from "vitepress";
import "@fontsource-variable/archivo/wdth.css";
import "@fontsource/commit-mono/400.css";
import "./style.css";
import Landing from "./components/Landing.vue";
import Mermaid from "./components/Mermaid.vue";
import NotFound from "./components/NotFound.vue";

export default {
  extends: DefaultTheme,
  Layout: () => h(DefaultTheme.Layout, null, { "not-found": () => h(NotFound) }),
  enhanceApp({ app }) {
    app.component("Landing", Landing);
    app.component("Mermaid", Mermaid);
  },
} satisfies Theme;
