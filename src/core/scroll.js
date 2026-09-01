/**
 * scroll.js — momentum smooth-scrolling.
 *
 * The page scrolls natively (so the scrollbar, keyboard, anchor links and
 * accessibility tools all behave), and we translate #scroll-content to an eased
 * position behind it. Body height is kept in sync with the content height.
 *
 * Disabled entirely for prefers-reduced-motion and coarse pointers, where
 * native scrolling already feels right and transform-scrolling hurts.
 *
 * Programmatic jumps (nav anchors) are tweened here rather than handed to
 * `window.scrollTo({behavior:'smooth'})`. On this page the native smooth
 * scroller is unreliable — measured either a ~700ms dead pause before it
 * starts, or no movement at all inside 1.5s, because the main thread is
 * saturated by the WebGL stage. Clicking a nav link and having nothing happen
 * is not a defect you ship. Owning the tween also means one easing curve
 * instead of a native ease stacked under our damping.
 */
import { state, bus, onFrame, damp, clamp } from './bus.js';

let content, spacer, enabled = false, target = 0, current = 0;
let jump = null;          // active programmatic tween
let nativeLoop = null;    // rAF handle for the non-enabled tween
let tweenUntil = 0;       // a programmatic scroll is in flight until this time

/* Sine in-out. A quartic in-out spends its first ~10% almost stationary, which
   on a 6000px jump is 125ms of "did my click register?" — the exact feeling
   this tween exists to remove. Sine leaves the mark immediately, peaks at only
   1.57x average velocity instead of 2x, and lands soft. */
const easeInOutSine = (t) => -(Math.cos(Math.PI * t) - 1) / 2;
const jumpDuration = (dist) => Math.min(1300, 460 + dist * 0.18);

export function initScroll() {
  content = document.getElementById('scroll-content');
  if (!content) return;

  enabled = !state.reducedMotion && !state.coarse && window.innerWidth > 900;

  // state.w / state.h are read by nav.js (hide-on-scroll threshold) and by the
  // GL stage. They have to stay current in BOTH branches — the old code only
  // wired resize when the smooth engine was on, so on mobile and under reduced
  // motion the viewport height was frozen at whatever it was on first paint.
  resize();
  window.addEventListener('resize', resize);

  if (!enabled) {
    document.body.style.height = '';
    content.style.transform = '';
    window.addEventListener('scroll', nativeSync, { passive: true });
    nativeSync();
    return;
  }

  Object.assign(content.style, {
    position: 'fixed', top: '0', left: '0', width: '100%', willChange: 'transform'
  });

  spacer = document.createElement('div');
  spacer.setAttribute('aria-hidden', 'true');
  spacer.style.cssText = 'pointer-events:none;width:1px;';
  document.body.appendChild(spacer);

  resize();
  const ro = new ResizeObserver(resize);
  ro.observe(content);

  window.addEventListener('scroll', onNativeScroll, { passive: true });
  target = current = window.scrollY;

  // Any real input cancels an in-flight jump — a programmatic scroll must
  // never fight the person holding the trackpad.
  const cancel = () => { jump = null; };
  window.addEventListener('wheel', cancel, { passive: true });
  window.addEventListener('touchstart', cancel, { passive: true });
  window.addEventListener('keydown', cancel);
  window.addEventListener('pointerdown', cancel, { passive: true });

  patchScrollIntoView();
  onFrame(tick);
}

/**
 * scrollIntoView(), repaired.
 *
 * Making #scroll-content position:fixed breaks a platform API for everything
 * inside it: the browser looks for an ancestor whose scrolling would move the
 * element, finds none, and silently does nothing. Measured consequences —
 * `/#services` as a deep link (main.js) lands on the hero, and the hero's
 * "Hear the work" button (player.js) is completely dead on desktop.
 *
 * The engine that broke the API is the right place to fix it, rather than
 * asking every current and future caller to know about our transform. Anything
 * outside the scroll container falls through to the native implementation.
 */
function patchScrollIntoView() {
  const native = Element.prototype.scrollIntoView;
  if (native.__smoothPatched) return;

  function patched(arg) {
    if (!enabled || !content || !content.contains(this)) return native.call(this, arg);

    const opts = (arg && typeof arg === 'object') ? arg : { block: arg === false ? 'end' : 'start' };
    if (opts.block === 'nearest') { ensureVisible(this); return; }

    const r = this.getBoundingClientRect();
    const delta = opts.block === 'center' ? r.top + r.height / 2 - state.h / 2
                : opts.block === 'end'    ? r.bottom - state.h
                : r.top;

    if (state.reducedMotion || opts.behavior === 'instant' || opts.behavior === 'auto') {
      const y = clamp(Math.round(current + delta), 0, maxScroll());
      jump = null; target = current = y;
      window.scrollTo(0, y);
      return;
    }
    scrollTo(this, delta - r.top);
  }
  patched.__smoothPatched = true;
  Element.prototype.scrollIntoView = patched;
}

function onNativeScroll() {
  target = window.scrollY;
  // The scrollbar, the keyboard or a wheel moved us somewhere the tween did
  // not ask for. Drop the tween and let damping take over from here.
  if (jump && Math.abs(target - jump.to) > 2) jump = null;
}

function nativeSync() {
  state.scrollRaw = window.scrollY;
  const prev = state.scroll;
  state.scroll = window.scrollY;
  state.velocity = state.scroll - prev;
  state.direction = state.velocity >= 0 ? 1 : -1;
  state.progress = clamp(state.scroll / maxScroll());
  bus.emit('scroll', state);
}

function maxScroll() {
  return Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
}

function resize() {
  state.w = window.innerWidth;
  state.h = window.innerHeight;
  if (!enabled || !content || !spacer) return;
  spacer.style.height = `${content.getBoundingClientRect().height}px`;
  // If the content got shorter, the browser clamps window.scrollY but our
  // eased position would otherwise sail past the new end of the document.
  const max = maxScroll();
  target = Math.min(target, max);
  current = Math.min(current, max);
  if (jump) jump.to = Math.min(jump.to, max);
}

function tick(dt) {
  if (!enabled) return;
  const prev = current;

  if (jump) {
    // Start the clock on the first frame we actually get. The WebGL layer can
    // block the main thread for half a second around first interaction, and a
    // tween clocked from the click would wake up already 60% done and teleport.
    if (jump.t0 === null) jump.t0 = performance.now();
    const p = Math.min(1, (performance.now() - jump.t0) / jump.dur);
    current = jump.from + (jump.to - jump.from) * easeInOutSine(p);
    if (p >= 1) { current = jump.to; target = jump.to; jump = null; }
  } else {
    // 12 = responsive but still weighty; tuned against a 120Hz display.
    current = damp(current, target, 12, dt);
    if (Math.abs(target - current) < 0.05) current = target;
  }

  content.style.transform = `translate3d(0, ${(-current).toFixed(2)}px, 0)`;

  state.scrollRaw = target;
  state.scroll = current;
  state.velocity = current - prev;
  state.direction = state.velocity >= 0 ? 1 : -1;
  state.progress = clamp(current / maxScroll());
  bus.emit('scroll', state);
}

/** Programmatic scroll used by nav links; respects the smooth engine. */
export function scrollTo(el, offset = 0) {
  const node = typeof el === 'string' ? document.querySelector(el) : el;
  if (!node) return;

  const base = enabled ? current : window.scrollY;
  const y = clamp(Math.round(node.getBoundingClientRect().top + base + offset), 0, maxScroll());

  const dur = jumpDuration(Math.abs(y - (enabled ? current : window.scrollY)));
  tweenUntil = performance.now() + dur + 120;

  if (state.reducedMotion) { window.scrollTo(0, y); if (enabled) current = target = y; return; }

  if (enabled) {
    // Arm the tween first, then move the native position immediately: the
    // scrollbar, focus scoping and any assistive tech read window.scrollY and
    // should not lag the visual. onNativeScroll only cancels a jump when the
    // native position disagrees with where the tween is headed.
    jump = { from: current, to: y, t0: null, dur };
    target = y;
    window.scrollTo(0, y);
    return;
  }

  nativeTween(y);
}

/** Same curve for the non-transform path (mobile, narrow desktop). */
function nativeTween(to) {
  const from = window.scrollY;
  const dist = Math.abs(to - from);
  if (dist < 2) return;
  const dur = jumpDuration(dist);
  if (nativeLoop) cancelAnimationFrame(nativeLoop);

  let t0 = null;
  let expected = from;
  const step = () => {
    // A real scroll landed between frames — the user took over.
    if (Math.abs(window.scrollY - expected) > 3) { nativeLoop = null; return; }
    // Clock from the first frame we get, not from the click: a long main-thread
    // block would otherwise leave the tween mid-curve and it would teleport.
    if (t0 === null) t0 = performance.now();
    const p = Math.min(1, (performance.now() - t0) / dur);
    expected = Math.round(from + (to - from) * easeInOutSine(p));
    window.scrollTo(0, expected);
    nativeLoop = p < 1 ? requestAnimationFrame(step) : null;
  };
  nativeLoop = requestAnimationFrame(step);
}

/**
 * Keep keyboard focus on screen.
 *
 * This is the tax on transform-scrolling. #scroll-content is position:fixed, so
 * when the browser tries to scroll a newly focused element into view it finds
 * no ancestor whose scrolling would move it, and does nothing. Measured: tabbing
 * out of the hero walked focus to elements 1576px, 1976px, 2296px down the page
 * while window.scrollY sat at 0 — a keyboard user driving an invisible cursor
 * around a page that never moves.
 *
 * We move the native position by the minimum needed and let the damping carry
 * the visual, so tabbing down a list nudges rather than re-centres each time.
 * PAD clears the fixed header at the top and the player dock at the bottom.
 */
const PAD = 120;
function ensureVisible(el) {
  if (!el || !content || !content.contains(el)) return;
  // An anchor click focuses its target; don't let that fight the tween that
  // click just started.
  if (performance.now() < tweenUntil) return;
  const r = el.getBoundingClientRect();
  if (!r.width && !r.height) return;

  let delta = 0;
  if (r.top < PAD) delta = r.top - PAD;
  else if (r.bottom > state.h - PAD) delta = Math.min(r.bottom - (state.h - PAD), r.top - PAD);
  if (!delta) return;

  const base = enabled ? current : window.scrollY;
  const y = clamp(Math.round(base + delta), 0, maxScroll());
  jump = null;
  window.scrollTo(0, y);
}
document.addEventListener('focusin', (e) => ensureVisible(e.target));

/** Where is this element, in 0..1, relative to the viewport? 0 = entering bottom, 1 = left top. */
export function viewportProgress(el) {
  const r = el.getBoundingClientRect();
  return 1 - (r.top + r.height) / (state.h + r.height);
}
