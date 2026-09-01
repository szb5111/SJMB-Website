/**
 * video.js — background loops that behave themselves.
 *
 * Clips only download when they scroll close, only play while visible, pause on
 * hidden tabs, and never load at all on save-data connections, slow networks or
 * reduced-motion.
 *
 * The still frame matters. These figures carry no <img> — the poster lives on
 * the <video> attribute — so the "don't play video" path must leave the video
 * element rendered and let it show its poster. Adding `is-poster-only` sets
 * `display:none` on the video (sections.css), which turned the studio band,
 * the session-work reel and the about-gallery cell into three empty boxes for
 * anyone with reduced motion or save-data on. A video with a poster and no
 * `src` downloads nothing and paints the still.
 *
 * play() is a promise that rejects for a dozen reasons — a load still in
 * flight, a tab that was hidden when the attempt was made, an interrupted
 * request. Fire-and-forget left all three clips loaded, decoded and frozen on
 * frame zero. Every attempt here is retried once the element says it can play.
 */
import { state } from '../core/bus.js';

const wants = new WeakSet();   // elements the observer currently wants playing

function still(v) {
  if (v.getAttribute('src')) { v.removeAttribute('src'); v.load(); }
  v.closest('.vfx')?.classList.add('is-live');   // opacity 1 — reveals the poster
}

function tryPlay(v) {
  if (!wants.has(v) || document.hidden || !v.src) return;
  const p = v.play();
  if (!p) return;
  p.catch(() => {
    if (!wants.has(v)) return;
    v.addEventListener('canplay', () => { if (wants.has(v) && !document.hidden) v.play().catch(() => {}); }, { once: true });
  });
}

export function initVideo() {
  const nodes = [...document.querySelectorAll('video[data-src]')];
  if (!nodes.length) return;

  const conn = navigator.connection || {};
  const cheap = conn.saveData === true || /^(slow-)?2g$/.test(conn.effectiveType || '');
  if (state.reducedMotion || cheap) {
    nodes.forEach(still);
    return;
  }

  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const v = e.target;
      if (!e.isIntersecting) { wants.delete(v); v.pause(); continue; }
      wants.add(v);
      if (!v.src) {
        v.addEventListener('loadeddata', () => {
          v.closest('.vfx')?.classList.add('is-live');
          tryPlay(v);
        }, { once: true });
        // A missing or undecodable clip must still leave the poster up.
        v.addEventListener('error', () => { wants.delete(v); still(v); }, { once: true });
        v.src = v.dataset.src;
        v.load();
      }
      tryPlay(v);
    }
  }, { rootMargin: '200px 0px' });

  nodes.forEach((v) => {
    v.muted = true; v.loop = true; v.playsInline = true; v.preload = 'none';
    io.observe(v);
  });

  document.addEventListener('visibilitychange', () => {
    // Coming back to the tab should not leave a frozen frame where a loop was.
    nodes.forEach((v) => (document.hidden ? v.pause() : tryPlay(v)));
  });
}
