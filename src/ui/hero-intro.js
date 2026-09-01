/**
 * hero-intro.js — the opening title sequence.
 *
 * Runs once, after the preloader lifts. Everything starts hidden via CSS
 * (`.hero [data-hero-el] { opacity: 0 }`), so there is never a flash of
 * un-animated hero.
 *
 * The delays below are measured from the moment `body.is-ready` lands, which
 * is also the moment the curtain starts its 480ms dissolve. Anything that
 * fires inside that window is animating behind black — the previous timeline
 * started the eyebrow at 80ms and both title lines by 350ms against a 900ms
 * fade, which meant the entire sequence played and finished before the curtain
 * was gone. You saw black, then a settled hero. The whole point was invisible.
 *
 * So: nothing moves until the curtain is essentially clear, then the type
 * rises into a frame the viewer can actually see.
 */
import { state } from '../core/bus.js';

/* Curtain dissolve is 480ms (chrome.css). Give it clearance, then start. */
const EYEBROW = 360;
const LINE_0  = 500;
const LINE_STEP = 140;
const REST_0  = 1000;
const REST_STEP = 110;

export function initHeroIntro() {
  const hero = document.querySelector('.hero');
  if (!hero) return;

  const lines = [...hero.querySelectorAll('[data-hero-line]')];
  const els   = [...hero.querySelectorAll('[data-hero-el]')];
  const timers = [];
  let played = false;

  const reveal = (el, delay) => timers.push(setTimeout(() => el.classList.add('is-in'), delay));

  const play = () => {
    if (played) return;
    played = true;

    if (state.reducedMotion) {
      lines.forEach((l) => l.classList.add('is-in'));
      els.forEach((e) => e.classList.add('is-in'));
      return;
    }
    // Eyebrow first, then the title lines, then everything below it.
    els.filter((e) => e.dataset.heroEl === '1').forEach((e) => reveal(e, EYEBROW));
    lines.forEach((l, i) => reveal(l, LINE_0 + i * LINE_STEP));
    els.filter((e) => e.dataset.heroEl !== '1')
       .forEach((e, i) => reveal(e, REST_0 + i * REST_STEP));
  };

  if (document.body.classList.contains('is-ready')) play();
  else {
    // The preloader adds .is-ready to <body> as the curtain lifts.
    const mo = new MutationObserver(() => {
      if (document.body.classList.contains('is-ready')) { mo.disconnect(); play(); }
    });
    mo.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    // Safety net: never leave the hero hidden, whatever happens upstream.
    // The preloader's own ceiling is 6s + ~1.2s of close sequence.
    setTimeout(() => { mo.disconnect(); play(); }, 8000);
  }

  // The hero CTAs are focusable while they are still at opacity 0. If a
  // keyboard user arrives mid-sequence, land the whole thing now rather than
  // let them tab onto something they cannot see.
  const skip = (e) => {
    if (e.key !== 'Tab') return;
    document.removeEventListener('keydown', skip);
    timers.forEach(clearTimeout);
    lines.forEach((l) => l.classList.add('is-in'));
    els.forEach((el) => el.classList.add('is-in'));
  };
  document.addEventListener('keydown', skip);
}
