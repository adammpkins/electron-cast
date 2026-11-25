// One source of truth for the recorded Cast v2 session: the frames in data/trace.json and the logic that replays them.
// The signal-path replay and the hero TV both build on useTrace(), so they read the same data the same way.
import { computed, onBeforeUnmount, ref } from "vue";
import trace from "../data/trace.json";

export interface Frame { t: number; dir: "out" | "in"; source: string; destination: string; namespace: string; type: string; payload: any }
export const meta = trace as { device?: { model?: string }; library?: string };
export const frames = (trace as { frames: Frame[] }).frames;
export const total = frames.length;
export const GAP = 1500; // a silence longer than this is marked and, unless real time is on, shortened

export const short = (ns: string) => ns.replace("urn:x-cast:com.google.cast.", "");
// which box of the signal-path diagram a frame belongs to: 4 network (device auth), 5 Cast v2 session, 6 the TV playing
export const hopOf = (f: Frame) => (/^tls$|deviceauth/.test(short(f.namespace)) ? 4 : /media$/.test(short(f.namespace)) ? 6 : 5);
export const clock = (ms: number) => "+" + (ms / 1000).toFixed(3) + "s";
export const gapBefore = (i: number) => (i > 0 ? frames[i].t - frames[i - 1].t : 0);
export const gapLabel = (i: number) => "+" + (gapBefore(i) / 1000).toFixed(1) + " s";
export const caption = `Recorded from a real session: ${(meta.library ?? "electron-cast").replace("@", " ")} casting to a ${meta.device?.model ?? "Chromecast"}.`;

const mediaState = (f: Frame) => (f.type === "MEDIA_STATUS" ? f.payload?.status?.[0] : undefined);
const mmss = (s: number) => Math.floor(s / 60) + ":" + String(Math.floor(s % 60)).padStart(2, "0");
// the first frame where the TV is really playing, and a later one with some play time on the clock (a still for reduced motion)
export const firstPlaying = frames.findIndex((f) => mediaState(f)?.playerState === "PLAYING");
export const stillAt = Math.max(firstPlaying, frames.findIndex((f) => (mediaState(f)?.currentTime ?? 0) > 3)) + 1;

/** What the first `cursor` frames add up to: is the TV on air, and what a status strip would say. */
export function statusAt(cursor: number) {
  const seen = frames.slice(0, cursor);
  let live = false, app = "", state = "", time = "";
  for (const f of seen) {
    if (f.type === "LAUNCH") app = f.payload?.appId ?? app;
    const m = mediaState(f);
    if (m) {
      state = m.playerState;
      time = mmss(m.currentTime ?? 0);
      if (m.playerState === "PLAYING") live = true;
    }
    if (f.type === "STOP") live = false;
    if (f.type === "STOP" || f.type === "CLOSE") state = f.type;
  }
  const last = seen[seen.length - 1];
  const route = last ? `${last.source} → ${last.destination}` : "";
  const tail = state ? `${state}${state === "PLAYING" || state === "PAUSED" || state === "BUFFERING" ? " " + time : ""}` : last ? last.type : "";
  return { live, route, app, tail, last };
}

export function useTrace(opts: { initial?: number; onEnd?: () => void } = {}) {
  const ready = ref(false);
  const cursor = ref(opts.initial ?? total);
  const playing = ref(false);
  const realTime = ref(false);
  const reduced = ref(false);
  let timer: ReturnType<typeof setTimeout> | undefined;

  const shown = computed(() => frames.slice(0, cursor.value));
  const last = computed(() => (cursor.value > 0 ? frames[cursor.value - 1] : null));
  const status = computed(() => statusAt(cursor.value));
  const say = computed(() => (last.value ? `Frame ${cursor.value} of ${total}: ${last.value.dir === "out" ? "sent" : "received"} ${last.value.type}` : "Idle. No signal."));

  function delay() {
    const gap = cursor.value < total ? gapBefore(cursor.value) : 0;
    if (realTime.value) return Math.max(30, gap);
    return Math.max(160, Math.min(gap, GAP));
  }
  function tick() {
    if (cursor.value >= total) return finish();
    cursor.value++;
    if (cursor.value >= total) finish();
    else timer = setTimeout(tick, delay());
  }
  function finish() {
    playing.value = false;
    opts.onEnd?.();
  }
  function pause() {
    clearTimeout(timer);
    playing.value = false;
  }
  function play() {
    if (reduced.value) return next();
    if (cursor.value >= total) cursor.value = 0;
    playing.value = true;
    timer = setTimeout(tick, cursor.value === 0 ? 150 : delay());
  }
  function next() {
    pause();
    if (cursor.value < total) cursor.value++;
  }
  function prev() {
    pause();
    if (cursor.value > 0) cursor.value--;
  }
  function reset() {
    pause();
    cursor.value = 0;
  }
  function scrub(e: Event) {
    pause();
    cursor.value = Number((e.target as HTMLInputElement).value);
  }
  const toggle = () => (playing.value ? pause() : play());
  const detectMotion = () => {
    reduced.value = matchMedia("(prefers-reduced-motion: reduce)").matches;
  };
  onBeforeUnmount(() => clearTimeout(timer));

  return { ready, cursor, playing, realTime, reduced, shown, last, status, say, play, pause, next, prev, reset, scrub, toggle, detectMotion };
}
