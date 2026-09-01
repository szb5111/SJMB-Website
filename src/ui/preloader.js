/**
 * preloader.js — holds the curtain until the fonts, the hero art and the first
 * WebGL frame are ready, so nobody ever sees the site assemble itself.
 *
 * Three rules this thing has to obey:
 *   1. The number never goes backwards, and it never lies. It counts up, it
 *      lands on 100, it holds for a beat, and only then does the curtain move.
 *   2. It is on screen long enough to be read. On a warm local cache the assets
 *      resolve in ~300ms — shorter than the lockup's own entrance animation —
 *      so MIN_HOLD keeps the title card up until it has actually played.
 *   3. It can never trap anyone. A hard ceiling, a timer-driven close path that
 *      does not require rAF (background tabs do not get frames), and a
 *      pure-CSS failsafe in chrome.css behind all of it.
 */
const MIN_HOLD  = 1250;  // lockup animation runs 1120ms; never cut it off
const HOLD_FULL = 260;   // beat at 100% before anything moves
const CEILING   = 6000;  // a slow CDN must never trap someone on a progress bar

export function initPreloader() {
  const root = document.getElementById('preloader');
  const fill = document.getElementById('preload-fill');
  const pct  = document.getElementById('preload-pct');
  if (!root || !fill || !pct) return { done: Promise.resolve(), finish() {}, bump() {} };

  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const t0 = performance.now();

  // The percentage rewrites itself ~60x a second inside a role="status"
  // aria-live region. Announced, that is a scream. The label alone carries it.
  document.querySelector('.preloader__meta')?.setAttribute('aria-hidden', 'true');

  let value = 0, target = 0;
  let closing = false, lifted = false, scheduled = false;

  const jobs = [];
  const track = (p) => { jobs.push(p); return p; };

  // Fonts
  if (document.fonts?.ready) track(document.fonts.ready);

  // Above-the-fold imagery
  const critical = ['assets/art/mirrors.jpg', 'assets/img/portrait-a.jpg'];
  critical.forEach((src) => track(new Promise((res) => {
    const img = new Image();
    img.onload = img.onerror = res;
    img.src = src;
  })));

  let loaded = 0;
  jobs.forEach((p) => p.then(() => {
    loaded++;
    target = Math.max(target, (loaded / jobs.length) * 0.8);
  }));

  const paint = () => {
    const shown = Math.round(value * 100);
    fill.style.transform = `scaleX(${value.toFixed(4)})`;
    pct.textContent = `${shown}%`;
  };

  const tick = () => {
    if (lifted) return;
    // Asset progress alone goes flat the instant the last job settles — on a
    // warm cache that is a bar frozen at 80% for half a second, which reads as
    // a hang. A slow asymptotic creep on top keeps it moving without ever
    // overtaking the truth or going backwards.
    const creep = 0.19 * (1 - Math.exp(-(performance.now() - t0) / 1500));
    const goal = closing ? 1 : Math.min(0.96, target + creep);
    const k    = closing ? 0.20 : 0.12;
    value += (goal - value) * k;
    if (closing && 1 - value < 0.005) value = 1;
    paint();
    if (closing && value === 1) { hold(); return; }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  const done = Promise.race([
    Promise.allSettled(jobs),
    new Promise((res) => setTimeout(res, CEILING))
  ]);

  /* ── the close sequence ───────────────────────────────────────────────── */
  function hold() {
    if (lifted) return;
    lifted = true;
    value = 1; paint();
    setTimeout(() => {
      // Stage one: the lockup leaves.
      root.classList.add('is-closing');
      setTimeout(() => {
        // Stage two: the curtain dissolves, and the hero timeline starts.
        root.classList.add('is-done');
        document.body.classList.add('is-ready');
        setTimeout(() => root.remove(), 900);
      }, reduced ? 0 : 220);
    }, reduced ? 0 : HOLD_FULL);
  }

  function finish() {
    if (scheduled) return;
    scheduled = true;
    const wait = reduced ? 0 : Math.max(0, MIN_HOLD - (performance.now() - t0));
    setTimeout(() => {
      closing = true;
      target = 1;
      // Background tabs get no animation frames, so the sweep above may never
      // run. Close on a timer regardless — the bar has nobody watching it.
      setTimeout(hold, reduced ? 0 : 700);
    }, wait);
  }

  // Absolute backstop, independent of main.js ever calling finish().
  setTimeout(finish, CEILING + 800);

  return { done, finish, bump(v) { target = Math.max(target, v); } };
}
