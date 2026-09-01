/**
 * main.js — boot order.
 *
 *   1. preloader starts counting immediately
 *   2. scroll engine + reveal + nav + cursor (cheap, synchronous)
 *   3. player (needs the DOM, not the GL)
 *   4. WebGL stage and its scenes, loaded async so a WebGL failure or a slow
 *      device never blocks the readable site
 *   5. curtain up
 *
 * Every step is individually guarded: if the WebGL layer throws, the site is
 * still a complete, readable, playable page.
 */
import { state } from './core/bus.js';
import { initScroll, scrollTo } from './core/scroll.js';
import { initReveal } from './ui/reveal.js';
import { initNav } from './ui/nav.js';
import { initCursor } from './ui/cursor.js';
import { initPlayer } from './ui/player.js';
import { initPreloader } from './ui/preloader.js';
import { initVideo } from './ui/video.js';
import { initHeroIntro } from './ui/hero-intro.js';
import { initStudioLayer } from './ui/studio-layer.js';

const pre = initPreloader();

function safe(label, fn) {
  try { fn(); } catch (err) { console.error(`[boot] ${label}`, err); }
}

safe('scroll', initScroll);
safe('nav', initNav);
safe('reveal', () => initReveal());
safe('cursor', initCursor);
safe('player', initPlayer);
safe('video', initVideo);
safe('hero-intro', initHeroIntro);
safe('studio-layer', initStudioLayer);

/* ── WebGL, optional by design ───────────────────────────────────────────── */
async function initGL() {
  const canvas = document.getElementById('gl');
  if (!canvas) return;

  // Cheap capability probe — bail before importing 1.3MB of three.js.
  const probe = document.createElement('canvas');
  const gl = probe.getContext('webgl2') || probe.getContext('webgl');
  if (!gl) { document.documentElement.classList.add('no-webgl'); return; }

  const { createStage } = await import('./gl/stage.js');
  const stage = createStage(canvas);

  const scenes = await Promise.allSettled([
    import('./gl/void.js'),
    import('./gl/hero.js'),
    import('./gl/chaos.js'),
    import('./gl/record.js')
  ]);

  for (const s of scenes) {
    if (s.status === 'fulfilled' && s.value.default) stage.add(s.value.default);
    else if (s.status === 'rejected') console.error('[gl] scene failed', s.reason);
  }

  document.documentElement.classList.add('has-webgl');
  return stage;
}

initGL()
  .catch((err) => { console.error('[boot] webgl', err); document.documentElement.classList.add('no-webgl'); })
  .finally(() => pre.bump(0.95));

/* ── Curtain up ──────────────────────────────────────────────────────────── */
pre.done.then(() => {
  // one more frame so the first GL render has landed
  requestAnimationFrame(() => requestAnimationFrame(() => pre.finish()));
});

/* Deep links land in the right place once the smooth engine is running. */
window.addEventListener('load', () => {
  if (!location.hash) return;
  const el = document.querySelector(location.hash);
  if (el) setTimeout(() => scrollTo(el, -8), 400);
});
