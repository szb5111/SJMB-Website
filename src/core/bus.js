/**
 * bus.js — a 40-line event bus plus the shared runtime state every module reads.
 * Everything that needs to know "how loud is it right now" or "where are we on
 * the page" reads `state`; nobody polls the DOM twice.
 */

const listeners = new Map();

export const bus = {
  on(evt, fn) {
    if (!listeners.has(evt)) listeners.set(evt, new Set());
    listeners.get(evt).add(fn);
    return () => bus.off(evt, fn);
  },
  off(evt, fn) { listeners.get(evt)?.delete(fn); },
  emit(evt, payload) {
    const set = listeners.get(evt);
    if (!set) return;
    for (const fn of set) {
      try { fn(payload); } catch (err) { console.error(`[bus:${evt}]`, err); }
    }
  }
};

/** Shared, mutable frame state. Written by scroll/audio, read by everything. */
export const state = {
  // viewport
  w: window.innerWidth,
  h: window.innerHeight,
  dpr: Math.min(window.devicePixelRatio || 1, 2),

  // scroll
  scroll: 0,        // eased scroll position in px
  scrollRaw: 0,     // native scroll position
  velocity: 0,      // px per frame, eased
  progress: 0,      // 0..1 through the document
  direction: 1,

  // time
  time: 0,          // seconds since boot
  dt: 0.016,        // seconds since last frame

  // audio (written by core/audio.js each frame)
  playing: false,
  level: 0,         // 0..1 overall loudness, smoothed
  bass: 0,          // 0..1 low band
  mid: 0,
  treble: 0,
  beat: 0,          // 0..1 decaying spike on transient
  accent: '#ff9a5a',// current track accent colour

  // capability
  reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  coarse: window.matchMedia('(pointer: coarse)').matches,
  quality: 1        // 0.5 low → 1 high, set by the perf governor
};

/** requestAnimationFrame with a shared clock — one loop for the whole site. */
const tasks = new Set();
let running = false;
let last = performance.now();

export function onFrame(fn) {
  tasks.add(fn);
  if (!running) { running = true; last = performance.now(); requestAnimationFrame(loop); }
  return () => tasks.delete(fn);
}

function loop(now) {
  const dt = Math.min((now - last) / 1000, 0.064); // clamp so tab-switches don't jump
  last = now;
  state.dt = dt;
  state.time += dt;
  for (const fn of tasks) {
    try { fn(dt, state.time); } catch (err) { console.error('[frame]', err); }
  }
  requestAnimationFrame(loop);
}

export const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
export const lerp = (a, b, t) => a + (b - a) * t;
/** Frame-rate independent damping — the correct way to ease toward a target. */
export const damp = (a, b, lambda, dt) => lerp(a, b, 1 - Math.exp(-lambda * dt));
export const map = (v, a, b, c, d) => c + ((v - a) / (b - a)) * (d - c);
export const smoothstep = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };
