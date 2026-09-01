/**
 * cursor.js — a difference-blended dot that swells over interactive things.
 * Pointer-fine devices only; the native cursor is never hidden on touch.
 *
 * Note that the OS arrow is never hidden here either — this dot is a companion
 * to it, not a replacement. That is the whole argument for tracking tightly:
 * a companion that trails 30px behind the arrow it is supposed to sit under
 * reads as a bug, not as weight. Lambda 50 keeps a hair of smoothing on the
 * raw pointer samples and nothing more.
 */
import { onFrame, damp, state } from '../core/bus.js';

const HOVER = [
  'a[href]', 'button', '[role="button"]', 'input', 'select', 'textarea',
  'summary', 'label[for]', '[tabindex]:not([tabindex="-1"])',
  '.tr', '.scrub__wave', '.about__gallery figure', '.quote'
].join(', ');

export function initCursor() {
  if (state.coarse || state.reducedMotion) return;

  const el = document.createElement('div');
  el.className = 'cursor';
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = '<span class="cursor__label"></span>';
  document.body.appendChild(el);
  const label = el.querySelector('.cursor__label');

  let tx = window.innerWidth / 2, ty = window.innerHeight / 2;
  let x = tx, y = ty;

  window.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse') return;
    tx = e.clientX; ty = e.clientY;
    el.classList.add('is-live');
  }, { passive: true });

  const press = (v) => el.style.setProperty('--squish', v);
  window.addEventListener('pointerdown', (e) => { if (e.pointerType === 'mouse') press('0.85'); }, { passive: true });
  // pointerup does not fire if the button is released outside the window, and
  // a stuck squish is a cursor that looks permanently mid-click.
  ['pointerup', 'pointercancel', 'blur'].forEach((ev) =>
    window.addEventListener(ev, () => press('1'), { passive: true }));

  const unhover = () => {
    if (!el.classList.contains('is-hover')) return;
    el.classList.remove('is-hover');
    label.textContent = '';
  };

  document.addEventListener('mouseleave', () => { el.classList.remove('is-live'); unhover(); });
  document.addEventListener('mouseenter', () => el.classList.add('is-live'));

  document.addEventListener('pointerover', (e) => {
    const hit = e.target.closest?.(HOVER);
    if (!hit) { unhover(); return; }
    el.classList.add('is-hover');
    label.textContent = hit.dataset.cursor || '';
  });
  document.addEventListener('pointerout', (e) => {
    if (e.target.closest?.(HOVER) && !e.relatedTarget?.closest?.(HOVER)) unhover();
  });
  // A target that disappears under the pointer (a drawer closing, the dock
  // hiding) fires no pointerout. Re-check on the next move instead.
  window.addEventListener('pointermove', (e) => {
    if (el.classList.contains('is-hover') && !e.target.closest?.(HOVER)) unhover();
  }, { passive: true });

  onFrame((dt) => {
    x = damp(x, tx, 50, dt);
    y = damp(y, ty, 50, dt);
    el.style.transform = `translate3d(${x.toFixed(2)}px, ${y.toFixed(2)}px, 0) translate(-50%, -50%) scale(var(--squish, 1))`;
  });
}
