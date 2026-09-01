/**
 * studio-layer.js — the hero's studio backdrop.
 * Fades the fixed layer out over the first viewport of scroll, and removes it
 * from the compositor entirely once invisible (which also lets video.js's
 * IntersectionObserver pause the clip).
 */
import { bus, clamp } from '../core/bus.js';

export function initStudioLayer() {
  const layer = document.getElementById('studio-layer');
  if (!layer) return;
  let hidden = false;
  bus.on('scroll', (s) => {
    const o = 1 - clamp(s.scroll / (s.h * 0.85));
    layer.style.setProperty('--studio-opacity', o.toFixed(3));
    const wantHidden = o < 0.02;
    if (wantHidden !== hidden) {
      hidden = wantHidden;
      layer.style.display = hidden ? 'none' : '';
    }
  });
}
