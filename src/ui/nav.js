/**
 * nav.js — sticky header behaviour, scroll-spy, mobile drawer, sound toggle.
 */
import { bus, state } from '../core/bus.js';
import { scrollTo } from '../core/scroll.js';
import { audio } from '../core/audio.js';

export function initNav() {
  const nav = document.getElementById('nav');
  const burger = document.getElementById('nav-burger');
  const drawer = document.getElementById('nav-drawer');
  const sound = document.getElementById('nav-sound');
  const links = [...document.querySelectorAll('.nav__links a')];

  /* ---- stick + hide-on-scroll-down ----
     A dead band around the last committed position: without it, the pixel of
     jitter at the end of an eased scroll flips the header between hidden and
     shown while it is still mid-transition. */
  const DEADBAND = 6;
  let lastY = 0;
  let jumpUntil = 0;   // set while an anchor tween is running
  bus.on('scroll', (s) => {
    nav.classList.toggle('is-stuck', s.scroll > 24);
    const goingDown = s.scroll > lastY + DEADBAND;
    const goingUp   = s.scroll < lastY - DEADBAND;
    if (!goingDown && !goingUp) return;
    lastY = s.scroll;
    if (drawer?.classList.contains('is-open')) return;
    // Clicking a nav link and watching the nav slide away is nonsense — the
    // header did not go anywhere, the page did.
    if (performance.now() < jumpUntil) return;
    if (goingDown && s.scroll > state.h * 0.9) nav.classList.add('is-hidden');
    else if (goingUp) nav.classList.remove('is-hidden');
  });

  /* ---- reading progress ----
     scaleX, not width: this runs on every scroll frame and `width` would force
     a layout pass each time. */
  const prog = document.getElementById('nav-progress');
  if (prog) bus.on('scroll', (s) => {
    prog.style.transform = `scaleX(${Math.min(1, Math.max(0, s.progress)).toFixed(4)})`;
  });

  /* ---- scroll-spy ----
     An IntersectionObserver band leaves the last match latched when nothing is
     inside the band, which lit "Approach" while you were sitting on the hero
     and left "About" lit all the way through the contact section. A reading
     line is deterministic: exactly one section can own it, and above the first
     section or below the last, nothing does. */
  const targets = links
    .map((a) => ({ a, el: document.querySelector(a.getAttribute('href')) }))
    .filter((t) => t.el);

  if (targets.length) {
    let bounds = [];
    const measure = () => {
      const base = state.scroll;
      bounds = targets
        .map((t) => {
          const r = t.el.getBoundingClientRect();
          return { a: t.a, top: r.top + base, bottom: r.bottom + base };
        })
        .sort((x, y) => x.top - y.top);
    };

    let active = null;
    const spy = (s) => {
      if (!bounds.length) return;
      const line = s.scroll + state.h * 0.4;
      let hit = null;
      for (const b of bounds) {
        if (line >= b.top) hit = b;
        else break;
      }
      // Past the end of the last section — the footer belongs to nobody.
      if (hit && line > bounds[bounds.length - 1].bottom) hit = null;
      const el = hit ? hit.a : null;
      if (el === active) return;
      active = el;
      links.forEach((a) => a.classList.toggle('is-active', a === el));
    };

    measure();
    bus.on('scroll', spy);
    window.addEventListener('resize', () => { measure(); });
    // The document keeps growing while fonts land, images decode and the
    // player builds its track list. Re-measure once things settle.
    const content = document.getElementById('scroll-content');
    if (content && 'ResizeObserver' in window) new ResizeObserver(measure).observe(content);
  }

  /* ---- smooth anchors ----
     preventDefault() on an in-page link also cancels the browser's move of the
     sequential-focus starting point, which is the only thing "Skip to content"
     actually does. Without restoring it the skip link is decorative: it scrolls
     to a hero that was already on screen and the next Tab goes back to the
     header. So we place focus on the target ourselves. */
  const focusTarget = (node) => {
    if (!node) return;
    if (!node.hasAttribute('tabindex')) {
      node.setAttribute('tabindex', '-1');
      node.addEventListener('blur', () => node.removeAttribute('tabindex'), { once: true });
    }
    node.focus({ preventScroll: true });
  };

  document.addEventListener('click', (e) => {
    // Leave modified clicks alone — cmd/ctrl-click is "open in a new tab".
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target.closest('a[href^="#"]');
    if (!a || a.target === '_blank') return;
    const id = a.getAttribute('href');
    const node = id === '#' ? null : document.querySelector(id);
    if (!node) return;
    e.preventDefault();
    // Focus goes back to the burger, which is visible; leaving it on a drawer
    // link would strand it inside a subtree that is about to become inert.
    closeDrawer();
    jumpUntil = performance.now() + 1500;   // longest jumpDuration + a beat
    nav.classList.remove('is-hidden');
    scrollTo(id, id === '#top' ? 0 : -8);
    focusTarget(node);
    history.replaceState(null, '', id);
  });

  /* ---- drawer ----
     `inert` on the drawer covers the closed state. Open, it is the rest of the
     page that has to go inert, or Tab walks straight out of the menu into the
     35-odd focusable things sitting behind the blur. */
  const FOCUSABLE = 'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])';
  let lastFocused = null;

  // Track exactly what we inert-ed so closing never strips an `inert` that
  // some other module owns.
  let inerted = [];

  function openDrawer() {
    if (!drawer || drawer.classList.contains('is-open')) return;
    lastFocused = document.activeElement;
    nav.classList.remove('is-hidden');       // never strand the close button
    drawer.classList.add('is-open');
    drawer.removeAttribute('inert');
    inerted = [...document.body.children].filter((el) =>
      el !== nav && el !== drawer && !el.classList.contains('cursor') && !el.hasAttribute('inert'));
    inerted.forEach((el) => el.setAttribute('inert', ''));
    burger.setAttribute('aria-expanded', 'true');
    burger.setAttribute('aria-label', 'Close menu');
    document.body.classList.add('is-locked');
    // `visibility` is in the drawer's transition (so the wipe-out stays visible
    // on close), which means the drawer is computed-hidden — and focus() a
    // silent no-op — until style has been recalculated at least once. A short
    // timeout is deterministic where a single rAF is not, and 90ms into a 720ms
    // wipe the menu is already on screen.
    setTimeout(() => {
      if (drawer.classList.contains('is-open')) drawer.querySelector(FOCUSABLE)?.focus({ preventScroll: true });
    }, 90);
  }

  function closeDrawer({ restoreFocus = true } = {}) {
    if (!drawer || !drawer.classList.contains('is-open')) return;
    drawer.classList.remove('is-open');
    drawer.setAttribute('inert', '');
    inerted.forEach((el) => el.removeAttribute('inert'));
    inerted = [];
    burger.setAttribute('aria-expanded', 'false');
    burger.setAttribute('aria-label', 'Open menu');
    document.body.classList.remove('is-locked');
    if (restoreFocus) (lastFocused && document.contains(lastFocused) ? lastFocused : burger)
      ?.focus({ preventScroll: true });
    lastFocused = null;
  }

  burger?.addEventListener('click', () => {
    drawer.classList.contains('is-open') ? closeDrawer() : openDrawer();
  });

  // Tapping the empty field of the menu closes it, like every other drawer.
  drawer?.addEventListener('click', (e) => { if (e.target === drawer) closeDrawer(); });

  document.addEventListener('keydown', (e) => {
    if (!drawer?.classList.contains('is-open')) return;
    if (e.key === 'Escape') { closeDrawer(); return; }
    if (e.key !== 'Tab') return;
    // Belt and braces on top of `inert`: keep the cycle inside nav + drawer.
    const ring = [...nav.querySelectorAll(FOCUSABLE), ...drawer.querySelectorAll(FOCUSABLE)]
      .filter((el) => el.offsetParent !== null || getComputedStyle(el).position === 'fixed');
    if (!ring.length) return;
    const first = ring[0], last = ring[ring.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });

  // A drawer that survives a rotation into desktop width is a trap.
  window.addEventListener('resize', () => {
    if (window.innerWidth > 1000) closeDrawer({ restoreFocus: false });
  });

  /* ---- sound toggle ---- */
  sound?.addEventListener('click', () => audio.toggle());
  bus.on('playstate', (on) => sound?.setAttribute('aria-pressed', String(on)));

  /* ---- footer year ---- */
  const year = document.getElementById('year');
  if (year) year.textContent = String(new Date().getFullYear());
}
