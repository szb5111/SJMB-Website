/**
 * reveal.js — scroll-triggered entrances.
 *
 * Everything with [data-reveal] fades/slides in once. Elements with .line-mask
 * children get a staggered per-line wipe. Uses IntersectionObserver, unobserves
 * after firing, and no-ops entirely under prefers-reduced-motion.
 *
 * The whole system waits for `body.is-ready`. Booting it earlier meant every
 * element above the fold burned its 1.1s entrance behind the preloader curtain
 * and was already settled by the time anyone could see it. Now the first screen
 * arrives with the curtain, which is the point of having a curtain.
 */
import { state } from '../core/bus.js';

export function initReveal(root = document) {
  const nodes = [...root.querySelectorAll('[data-reveal]')];

  if (state.reducedMotion) {
    nodes.forEach((n) => n.classList.add('is-in'));
    root.querySelectorAll('.line-mask').forEach((n) => n.classList.add('is-in'));
    return;
  }

  // threshold 0 + a 10% bottom inset: fire as soon as the element crosses 90%
  // of the viewport. A threshold of 0.12 made tall blocks wait until an eighth
  // of their whole height was past the line, which on a fast scroll meant
  // reading a paragraph while it was still half transparent.
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      e.target.classList.add('is-in');
      stagger(e.target);
      io.unobserve(e.target);
    }
  }, { rootMargin: '0px 0px -10% 0px', threshold: 0 });

  const start = () => {
    nodes.forEach((n) => io.observe(n));
    // Anything already on screen when the curtain lifts should just be in.
    requestAnimationFrame(() => {
      nodes.forEach((n) => {
        if (n.classList.contains('is-in')) return;
        if (n.getBoundingClientRect().top < window.innerHeight * 0.9) {
          n.classList.add('is-in'); stagger(n); io.unobserve(n);
        }
      });
    });
  };

  if (root !== document || document.body.classList.contains('is-ready')) { start(); return; }

  const mo = new MutationObserver(() => {
    if (document.body.classList.contains('is-ready')) { mo.disconnect(); clearTimeout(net); start(); }
  });
  mo.observe(document.body, { attributes: true, attributeFilter: ['class'] });
  // Never leave the page invisible because the curtain never lifted.
  const net = setTimeout(() => { mo.disconnect(); start(); }, 8000);
}

function stagger(el) {
  const lines = el.matches('.line-mask') ? [el] : [...el.querySelectorAll('.line-mask')];
  lines.forEach((l, i) => {
    if (l.classList.contains('is-in')) return;
    l.style.setProperty('--line-delay', `${i * 90}ms`);
    l.classList.add('is-in');
  });
}

/** Split a text node into per-line masks. Used for the big display headings. */
export function splitLines(el) {
  const text = el.textContent.trim();
  const words = text.split(/\s+/);
  el.textContent = '';
  const probe = document.createElement('span');
  probe.style.cssText = 'display:inline-block';
  const frag = document.createDocumentFragment();
  words.forEach((w, i) => {
    const s = probe.cloneNode();
    s.textContent = w + (i < words.length - 1 ? ' ' : '');
    frag.appendChild(s);
  });
  el.appendChild(frag);
}
