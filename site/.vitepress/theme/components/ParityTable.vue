<script setup lang="ts">
// "As Chrome does it": each row opens to the Chromium source it is tied to (native <details>, so it works without JS).
import { ExternalLink } from "lucide-vue-next";
const CHROMIUM = "https://source.chromium.org/chromium/chromium/src/+/main:";
const rows = [
  {
    rule: "Casting starts from a click",
    chrome: "The browser process requires transient user activation on the requesting frame.",
    here: "The preload reads navigator.userActivation.isActive and the main process refuses a start without it. A compromised renderer could still forge it; SECURITY.md says so.",
    src: ["content/browser/presentation/presentation_service_impl.cc"],
  },
  {
    rule: "Every frame is its own sender",
    chrome: "Availability watches, connections and sessions belong to one frame. A frame that navigates parks its sessions.",
    here: "Same per-frame rules, and the origin used for allowOrigin and the picker is the frame's own. Iframes need nodeIntegrationInSubFrames, and are covered by unit tests only.",
    src: [
      "content/browser/presentation/presentation_service_impl.cc",
      "components/media_router/browser/presentation/controller_presentation_service_delegate_impl.cc",
    ],
  },
  {
    rule: "Devices are checked before use",
    chrome: "A device must prove a chain to a Cast root, sign over this connection's TLS certificate, and pass revocation.",
    here: "A port of those checks with no dependencies, on by default. One difference: a stale built-in CRL skips revocation after 20 weeks instead of refusing every device.",
    src: [
      "components/media_router/common/providers/cast/channel/cast_auth_util.cc",
      "components/media_router/common/providers/cast/certificate/cast_cert_validator.cc",
    ],
  },
  {
    rule: "Rejoin after a restart",
    chrome: "Auto-join ignores sessions Chrome did not start. Joining by id works, and checks only the app and that the client is not already connected.",
    here: "Your app keeps the session id and calls requestSessionById. electron-cast asks the known devices which one runs it. The library persists nothing.",
    src: ["chrome/browser/media/router/providers/cast/cast_activity_manager.cc"],
  },
  {
    rule: "Stopping a cast",
    chrome: "The Cast dialog's stop terminates the route, which stops the receiver app.",
    here: "terminateRoute(id) on the cast manager. detachRoute is electron-cast's own: Chrome's Cast provider leaves it unimplemented.",
    src: ["chrome/browser/ui/media_router/media_router_ui.cc", "chrome/browser/media/router/providers/cast/cast_activity_manager.cc"],
  },
  {
    rule: "A picker that keeps listening",
    chrome: "The dialog watches devices while it is open, so a TV that wakes up appears in the list.",
    here: "selectDevice gets a third argument that streams devices found while your picker is open.",
    src: ["chrome/browser/ui/media_router/query_result_manager.cc"],
  },
];
</script>

<template>
  <div class="parity">
    <details v-for="r in rows" :key="r.rule" class="prow">
      <summary>
        <span class="pr">{{ r.rule }}</span><span class="pm" aria-hidden="true" />
      </summary>
      <div class="pb">
        <div>
          <h3>Chrome</h3>
          <p>{{ r.chrome }}</p>
        </div>
        <div>
          <h3>electron-cast</h3>
          <p>{{ r.here }}</p>
        </div>
        <ul class="ps" aria-label="Chromium source">
          <li v-for="s in r.src" :key="s">
            <a :href="CHROMIUM + s" rel="noopener" target="_blank"><code>{{ s }}</code><ExternalLink aria-hidden="true" /></a>
          </li>
        </ul>
      </div>
    </details>
  </div>
</template>

<style scoped>
.parity { border-top: 2px solid var(--ec-ink); }
.prow { border-bottom: 1px solid var(--ec-line); }
summary { list-style: none; cursor: pointer; display: flex; justify-content: space-between; align-items: center; gap: 1rem; padding: 1.05rem 0.25rem; }
summary::-webkit-details-marker { display: none; }
.pr { font-family: var(--ec-display); font-variation-settings: "wdth" 80; font-weight: 800; font-size: 1.3rem; letter-spacing: -0.01em; }
.pm { width: 14px; height: 14px; flex: none; box-sizing: border-box; background: transparent; border: 2px solid var(--ec-ink); margin-right: 0.25rem; }
.prow[open] .pm { background: var(--ec-tally); border-color: var(--ec-tally); }
summary:hover .pr { color: var(--ec-signal); }
.pb { display: grid; gap: 1.2rem 2.5rem; grid-template-columns: 1fr; padding: 0.2rem 0.25rem 1.5rem; }
@media (min-width: 800px) { .pb { grid-template-columns: 1fr 1fr; } .ps { grid-column: 1 / -1; } }
.pb h3 { margin: 0 0 0.2rem !important; font-family: var(--ec-display); font-weight: 700; font-size: 0.85rem; color: var(--ec-muted); font-variation-settings: "wdth" 100; }
.pb p { margin: 0 !important; line-height: 1.6; max-width: 58ch; }
.ps { list-style: none; padding: 0; margin: 0 !important; display: grid; gap: 0.3rem; }
.ps li { margin: 0 !important; }
.ps a { display: inline-flex; align-items: center; gap: 0.4rem; color: var(--ec-signal); text-decoration: none; font-size: 0.8rem; overflow-wrap: anywhere; }
.ps a:hover code { text-decoration: underline; }
.ps code { font-family: var(--ec-mono); background: none !important; color: inherit !important; padding: 0 !important; font-size: inherit !important; }
.ps svg { width: 12px; height: 12px; flex: none; }
</style>
