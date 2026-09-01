/**
 * player.js — the listening station.
 * Builds the whole component into [data-player], wires transport, playlist,
 * scrubbing, keyboard shortcuts and the sticky mini-dock.
 *
 * Layout: now-playing (art + credits) and the playlist share the top row so the
 * two columns always agree on height; the scrubber and transport run as one
 * full-width deck beneath them.
 */
import { audio } from '../core/audio.js';
import { scrollTo } from '../core/scroll.js';
import { bus, state, onFrame, damp, clamp } from '../core/bus.js';
import { loadPeaks, placeholderPeaks, drawWave, peaksCached } from './waveform.js';

const fmt = (s) => {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
};
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const ICON = {
  play:  '<svg class="ic-play" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.2v13.6L19.2 12z"/></svg>',
  pause: '<svg class="ic-pause" viewBox="0 0 24 24" aria-hidden="true"><rect x="6.6" y="5.2" width="3.8" height="13.6" rx="1.2"/><rect x="13.6" y="5.2" width="3.8" height="13.6" rx="1.2"/></svg>',
  prev:  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 5.6v12.8L9.4 12z" fill="currentColor" stroke="none"/><rect x="4.6" y="5.4" width="2.2" height="13.2" rx="1.1" fill="currentColor" stroke="none"/></svg>',
  next:  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5.6v12.8L14.6 12z" fill="currentColor" stroke="none"/><rect x="17.2" y="5.4" width="2.2" height="13.2" rx="1.1" fill="currentColor" stroke="none"/></svg>',
  back10:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4.6a7.4 7.4 0 1 1-7.3 8.7"/><path d="M4.6 4.4v4.3h4.3"/><text x="12" y="15.6" text-anchor="middle" font-size="7.6">10</text></svg>',
  fwd10: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4.6a7.4 7.4 0 1 0 7.3 8.7"/><path d="M19.4 4.4v4.3h-4.3"/><text x="12" y="15.6" text-anchor="middle" font-size="7.6">10</text></svg>',
  shuffle:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7h3.6l3 5m0 0 3 5H19M3 17h3.6l3-5"/><path d="M16.2 4.4 19.4 7l-3.2 2.6M16.2 14.4l3.2 2.6-3.2 2.6"/></svg>',
  repeat:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12a5 5 0 0 1 5-5h9"/><path d="M20 12a5 5 0 0 1-5 5H6"/><path d="m15 4 3.2 3L15 10M9 14l-3.2 3L9 20"/></svg>',
  vol:   '<svg class="ic-vol" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 9.4h3.2L12.6 6v12L8.2 14.6H5z" fill="currentColor" stroke-linejoin="round"/><path d="M16 9.2a4 4 0 0 1 0 5.6"/><path d="M18.4 6.6a7.5 7.5 0 0 1 0 10.8"/></svg>',
  muted: '<svg class="ic-muted" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 9.4h3.2L12.6 6v12L8.2 14.6H5z" fill="currentColor" stroke-linejoin="round"/><path d="m16.4 9.6 4.4 4.8M20.8 9.6l-4.4 4.8"/></svg>'
};

export function initPlayer() {
  const mount = document.querySelector('[data-player]');
  if (!mount) return;

  let shuffle = false, repeat = false, order = null;
  let peaks = placeholderPeaks(audio.track.id);
  let peaksPending = false;
  let displayProgress = 0;
  let hoverRatio = -1;

  /* Real peaks mean fetching + decoding the whole mp3 (Mirrors alone is ~12 MB),
     so we never do it on load. The placeholder carries the UI until the visitor
     actually engages — presses play, grabs the scrubber, or picks a track. */
  let engaged = false;
  let peaksRequestedFor = null;

  const frugalConnection = () => {
    const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    return !!(c && (c.saveData || /(^|-)2g$/.test(c.effectiveType || '')));
  };

  async function requestPeaks(track) {
    if (frugalConnection()) return;              // stay on the placeholder, cost nothing
    if (peaksRequestedFor === track.id) return;
    peaksRequestedFor = track.id;
    peaksPending = true;
    const real = await loadPeaks(track);
    if (audio.track.id === track.id) { peaks = real; peaksPending = false; }
  }

  /** First real intent signal — from here on, tracks decode as they're selected. */
  function engage() {
    engaged = true;
    requestPeaks(audio.track);
  }

  /* ─────────── markup ─────────── */
  mount.innerHTML = `
    <div class="np">
      <div class="np__art">
        <span class="np__art-glow"></span>
        <span class="np__badge"><i class="np__badge-dot" aria-hidden="true"></i>Now playing<b id="np-num">01</b></span>
        ${audio.tracks.map((t, i) => `<img src="${esc(t.art)}" alt="" data-art="${i}" ${i === 0 ? 'class="is-current"' : ''} loading="${i < 2 ? 'eager' : 'lazy'}" decoding="async">`).join('')}
      </div>
      <div class="np__meta">
        <span class="np__genre" id="np-genre"></span>
        <h3 class="np__title" id="np-title"></h3>
        <p class="np__artist" id="np-artist"></p>
        <p class="np__credit" id="np-credit"></p>
      </div>
    </div>

    <div class="pl">
      <div class="pl__head">
        <span class="pl__head-label">The Reel</span>
        <span class="pl__head-count"><b>${audio.tracks.length}</b> tracks</span>
      </div>
      <ul class="pl__list" id="pl-list"></ul>
      <div class="pl__foot">
        <span class="pl__sig">Produced &amp; mixed by Shane</span>
        <span class="pl__kbd"><kbd>Space</kbd><kbd>←</kbd><kbd>→</kbd></span>
      </div>
    </div>

    <div class="deck">
      <div class="scrub">
        <div class="scrub__wave" id="scrub" role="slider" tabindex="0" data-cursor="Scrub"
             aria-label="Seek" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" aria-valuetext="0:00 of 0:00">
          <canvas id="wave"></canvas>
          <span class="scrub__hover" id="scrub-hover"></span>
          <span class="scrub__head" id="scrub-head"><i></i></span>
          <span class="scrub__tip" id="scrub-tip">0:00</span>
        </div>
        <p class="scrub__times">
          <b id="t-cur">0:00</b>
          <span class="scrub__dash" aria-hidden="true"></span>
          <span id="t-dur">0:00</span>
        </p>
      </div>

      <div class="deck__row">
        <p class="deck__status" id="deck-status">
          <span class="deck__count"><b id="deck-idx">01</b> / ${String(audio.tracks.length).padStart(2, '0')}</span>
          <span class="deck__status-txt" id="deck-status-txt" role="status"></span>
        </p>

        <div class="tp">
          <button class="tp__btn tp__btn--mini" id="b-shuffle" type="button" aria-pressed="false" aria-label="Shuffle" title="Shuffle" data-cursor="Shuffle">${ICON.shuffle}<i class="tp__dot" aria-hidden="true"></i></button>
          <button class="tp__btn" id="b-back" type="button" aria-label="Back 10 seconds" title="Back 10s" data-cursor="−10s">${ICON.back10}</button>
          <button class="tp__btn tp__btn--major" id="b-prev" type="button" aria-label="Previous track" title="Previous" data-cursor="Prev">${ICON.prev}</button>
          <button class="tp__play" id="b-play" type="button" aria-label="Play" title="Play" data-cursor="Play">
            <span class="tp__ring" aria-hidden="true"></span>${ICON.play}${ICON.pause}
          </button>
          <button class="tp__btn tp__btn--major" id="b-next" type="button" aria-label="Next track" title="Next" data-cursor="Next">${ICON.next}</button>
          <button class="tp__btn" id="b-fwd" type="button" aria-label="Forward 10 seconds" title="Forward 10s" data-cursor="+10s">${ICON.fwd10}</button>
          <button class="tp__btn tp__btn--mini" id="b-repeat" type="button" aria-pressed="false" aria-label="Repeat track" title="Repeat" data-cursor="Repeat">${ICON.repeat}<i class="tp__dot" aria-hidden="true"></i></button>
        </div>

        <div class="tp__vol">
          <button class="tp__btn tp__btn--mini" id="b-mute" type="button" aria-pressed="false" aria-label="Mute" title="Mute" data-cursor="Mute">${ICON.vol}${ICON.muted}</button>
          <input id="vol" type="range" min="0" max="1" step="0.01" value="${audio.volume}" aria-label="Volume">
        </div>
      </div>
    </div>
  `;

  /* ─────────── refs ─────────── */
  const $ = (id) => mount.querySelector(`#${id}`);
  const arts    = [...mount.querySelectorAll('[data-art]')];
  const glow    = mount.querySelector('.np__art-glow');
  const npNum   = $('np-num'), npGenre = $('np-genre'), npTitle = $('np-title'),
        npArtist= $('np-artist'), npCredit = $('np-credit');
  const scrub   = $('scrub'), canvas = $('wave'), head = $('scrub-head'),
        hover   = $('scrub-hover'), tip = $('scrub-tip');
  const tCur    = $('t-cur'), tDur = $('t-dur');
  const bPlay   = $('b-play'), vol = $('vol'), bMute = $('b-mute');
  const list    = $('pl-list');
  const statusEl = $('deck-status'), statusTxt = $('deck-status-txt'), deckIdx = $('deck-idx');

  /* ─────────── playlist ─────────── */
  list.innerHTML = audio.tracks.map((t, i) => `
    <li class="pl__row">
      <button class="tr" type="button" data-track="${i}" data-cursor="Play" aria-label="Play ${esc(t.title)} by ${esc(t.artist)}">
        <span class="tr__idx">
          <span class="tr__idx-n">${String(i + 1).padStart(2, '0')}</span>
          <span class="tr__idx-play" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M8 5.2v13.6L19.2 12z" fill="currentColor"/></svg></span>
          <span class="tr__bars" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
        </span>
        <span class="tr__art"><img src="${esc(t.art)}" alt="" width="64" height="64" loading="lazy" decoding="async"></span>
        <span class="tr__txt">
          <span class="tr__title">${esc(t.title)}${t.sub ? ` <span class="tr__sub-note">${esc(t.sub)}</span>` : ''}</span>
          <span class="tr__artist">${esc(t.artist)}</span>
        </span>
        <span class="tr__genre">${esc(t.genre)}</span>
        <span class="tr__dur">${fmt(t.duration)}</span>
      </button>
    </li>`).join('');

  list.addEventListener('pointerdown', (e) => { if (e.target.closest('[data-track]')) engage(); });
  list.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-track]');
    if (!btn) return;
    const i = +btn.dataset.track;
    if (i === audio.index) audio.toggle();
    else audio.load(i, { play: true });
  });

  /* scroll affordance: soft edge fades, only while the list actually scrolls */
  const syncScrollFades = () => {
    const over = list.scrollHeight - list.clientHeight;
    list.classList.toggle('is-scrollable', over > 2);
    if (over <= 2) { list.style.setProperty('--fade-t', '0px'); list.style.setProperty('--fade-b', '0px'); return; }
    list.style.setProperty('--fade-t', `${Math.min(24, list.scrollTop)}px`);
    list.style.setProperty('--fade-b', `${Math.min(24, over - list.scrollTop)}px`);
  };
  list.addEventListener('scroll', syncScrollFades, { passive: true });
  if ('ResizeObserver' in window) new ResizeObserver(syncScrollFades).observe(list);
  syncScrollFades();

  /* ─────────── transport ─────────── */
  bPlay.addEventListener('click', () => audio.toggle());
  $('b-next').addEventListener('click', () => nextTrack());
  $('b-prev').addEventListener('click', () => audio.prev());
  $('b-fwd').addEventListener('click',  () => audio.seekBy(10));
  $('b-back').addEventListener('click', () => audio.seekBy(-10));

  $('b-shuffle').addEventListener('click', (e) => {
    shuffle = !shuffle;
    order = shuffle ? shuffledOrder() : null;
    e.currentTarget.setAttribute('aria-pressed', String(shuffle));
    e.currentTarget.title = shuffle ? 'Shuffle on' : 'Shuffle';
  });
  $('b-repeat').addEventListener('click', (e) => {
    repeat = !repeat;
    e.currentTarget.setAttribute('aria-pressed', String(repeat));
    e.currentTarget.title = repeat ? 'Repeat on' : 'Repeat';
  });

  let lastVol = audio.volume || 0.72;
  bMute.addEventListener('click', () => {
    if (audio.volume > 0) { lastVol = audio.volume; audio.setVolume(0); }
    else audio.setVolume(lastVol || 0.72);
  });
  vol.addEventListener('input', () => audio.setVolume(+vol.value));
  const syncVol = (v) => {
    vol.value = v;
    vol.style.setProperty('--pct', `${Math.round(v * 100)}%`);
    vol.setAttribute('aria-valuetext', `${Math.round(v * 100)}%`);
    const off = v <= 0.001;
    bMute.classList.toggle('is-muted', off);
    bMute.setAttribute('aria-pressed', String(off));
    bMute.setAttribute('aria-label', off ? 'Unmute' : 'Mute');
    bMute.title = off ? 'Unmute' : 'Mute';
  };
  bus.on('volume', syncVol);
  syncVol(audio.volume);

  function shuffledOrder() {
    const a = audio.tracks.map((_, i) => i).filter((i) => i !== audio.index);
    for (let i = a.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [a[i], a[j]] = [a[j], a[i]]; }
    return [audio.index, ...a];
  }
  function nextTrack() {
    if (repeat) { audio.seek(0); audio.play(); return; }
    if (shuffle) {
      if (!order?.length) order = shuffledOrder();
      const at = order.indexOf(audio.index);
      audio.load(order[(at + 1) % order.length], { play: true });
      return;
    }
    audio.next();
  }
  audio.el.addEventListener('ended', (e) => { e.stopImmediatePropagation?.(); }, true);
  bus.on('playstate', (on) => {
    mount.classList.toggle('is-playing', on);
    bPlay.setAttribute('aria-label', on ? 'Pause' : 'Play');
    bPlay.title = on ? 'Pause' : 'Play';
    bPlay.dataset.cursor = on ? 'Pause' : 'Play';
    dkPlay.setAttribute('aria-label', on ? 'Pause' : 'Play');
    dock.classList.toggle('is-playing', on);
    if (on) { setStatus(''); engage(); }
  });

  /* ─────────── designed loading / error states ─────────── */
  let errored = false;
  const setStatus = (kind) => {
    mount.classList.toggle('is-loading', kind === 'loading');
    mount.classList.toggle('is-error', kind === 'error');
    statusTxt.textContent =
      kind === 'error'   ? 'Audio unavailable' :
      kind === 'loading' ? 'Buffering' : '';
    statusEl.dataset.kind = kind || 'idle';
  };
  const el = audio.el;
  // "Buffering" is only meaningful once someone is actually trying to listen —
  // on a cold page load the element is only pulling metadata.
  const busy = () => { if (!errored && engaged) setStatus('loading'); };
  const idle = () => { if (!errored) setStatus(''); };
  el.addEventListener('waiting', busy);
  el.addEventListener('stalled', busy);
  el.addEventListener('loadstart', busy);
  el.addEventListener('canplay', idle);
  el.addEventListener('playing', idle);
  el.addEventListener('seeked', idle);
  el.addEventListener('loadedmetadata', idle);
  bus.on('audioerror', () => { errored = true; setStatus('error'); });

  /* ─────────── scrubbing ─────────── */
  let dragging = false;
  const ratioFromEvent = (e) => {
    const r = scrub.getBoundingClientRect();
    return clamp((e.clientX - r.left) / r.width);
  };
  scrub.addEventListener('pointerdown', (e) => {
    engage();
    dragging = true;
    scrub.classList.add('is-dragging');
    try { scrub.setPointerCapture(e.pointerId); } catch {}
    audio.seek(ratioFromEvent(e) * audio.duration);
  });
  scrub.addEventListener('pointermove', (e) => {
    const r = ratioFromEvent(e);
    hoverRatio = r;
    hover.style.left = `${r * 100}%`;
    tip.style.left = `${r * 100}%`;
    tip.textContent = fmt(r * audio.duration);
    if (dragging) audio.seek(r * audio.duration);
  });
  scrub.addEventListener('pointerleave', () => { if (!dragging) hoverRatio = -1; });
  const endDrag = (e) => {
    if (!dragging) return;
    dragging = false;
    scrub.classList.remove('is-dragging');
    try { scrub.releasePointerCapture(e.pointerId); } catch {}
  };
  scrub.addEventListener('pointerup', endDrag);
  scrub.addEventListener('pointercancel', endDrag);
  scrub.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 30 : 5;
    if (e.key === 'ArrowRight') { audio.seekBy(step); e.preventDefault(); }
    if (e.key === 'ArrowLeft')  { audio.seekBy(-step); e.preventDefault(); }
    if (e.key === 'Home') { audio.seek(0); e.preventDefault(); }
    if (e.key === 'End')  { audio.seek(Math.max(0, audio.duration - 1)); e.preventDefault(); }
  });

  /* ─────────── keyboard, globally ─────────── */
  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    switch (e.key) {
      case ' ': case 'k': audio.toggle(); e.preventDefault(); break;
      case 'ArrowRight': if (e.target === document.body) { audio.seekBy(5); e.preventDefault(); } break;
      case 'ArrowLeft':  if (e.target === document.body) { audio.seekBy(-5); e.preventDefault(); } break;
      case 'ArrowUp':    if (e.target === document.body) { audio.setVolume(audio.volume + 0.08); e.preventDefault(); } break;
      case 'ArrowDown':  if (e.target === document.body) { audio.setVolume(audio.volume - 0.08); e.preventDefault(); } break;
      case 'j': audio.prev(); break;
      case 'l': nextTrack(); break;
      case 'm': bMute.click(); break;
    }
  });

  /* ─────────── hero play button ─────────── */
  document.getElementById('hero-play')?.addEventListener('click', () => {
    audio.play();
    scrollTo('#work', -8);
  });

  /* ─────────── sticky dock ─────────── */
  const dock = document.getElementById('dock');
  dock.hidden = false;
  dock.innerHTML = `
    <img class="dock__art" id="dk-art" src="${esc(audio.track.art)}" alt="">
    <button class="tp__play tp__play--dock" id="dk-play" type="button" aria-label="Play" data-cursor="Play">${ICON.play}${ICON.pause}</button>
    <span class="dock__txt"><span class="dock__title" id="dk-title"></span><span class="dock__artist" id="dk-artist"></span></span>
    <button class="tp__btn tp__btn--mini" id="dk-next" type="button" aria-label="Next track" data-cursor="Next">${ICON.next}</button>
    <button class="tp__btn tp__btn--mini" id="dk-close" type="button" aria-label="Hide player" data-cursor="Hide">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17"/></svg>
    </button>
    <span class="dock__bar"><i id="dk-bar"></i></span>`;
  const dkArt = dock.querySelector('#dk-art'), dkTitle = dock.querySelector('#dk-title'),
        dkArtist = dock.querySelector('#dk-artist'), dkBar = dock.querySelector('#dk-bar'),
        dkPlay = dock.querySelector('#dk-play');
  dkPlay.addEventListener('click', () => audio.toggle());
  dock.querySelector('#dk-next').addEventListener('click', () => nextTrack());
  let dockDismissed = false;
  dock.querySelector('#dk-close').addEventListener('click', () => { dockDismissed = true; dock.classList.remove('is-up'); });

  // The dock rises when the player section has scrolled away and audio is live.
  const workSection = document.getElementById('work');
  const dockIO = new IntersectionObserver(([e]) => {
    dock.dataset.away = String(!e.isIntersecting);
  }, { threshold: 0.18 });
  if (workSection) dockIO.observe(workSection);

  /* ─────────── track change ─────────── */
  bus.on('track', ({ index, track }) => {
    errored = false;
    setStatus(engaged ? 'loading' : '');
    mount.style.setProperty('--pl-accent', track.accent);
    dock.style.setProperty('--pl-accent', track.accent);
    npNum.textContent = String(index + 1).padStart(2, '0');
    deckIdx.textContent = String(index + 1).padStart(2, '0');
    npGenre.textContent = track.genre;
    npTitle.innerHTML = esc(track.title) + (track.sub ? `<em>${esc(track.sub)}</em>` : '');
    npArtist.textContent = track.artist;
    npCredit.textContent = track.credit;
    tDur.textContent = fmt(track.duration);

    arts.forEach((img, i) => img.classList.toggle('is-current', i === index));
    [...list.querySelectorAll('.tr')].forEach((b, i) => {
      const cur = i === index;
      b.classList.toggle('is-current', cur);
      b.dataset.cursor = cur ? 'Pause' : 'Play';
      b.setAttribute('aria-current', cur ? 'true' : 'false');
    });

    dkArt.src = track.art;
    dkTitle.textContent = track.title;
    dkArtist.textContent = track.artist;

    peaks = placeholderPeaks(track.id);
    peaksPending = false;
    peaksRequestedFor = null;
    displayProgress = 0;
    hoverRatio = -1;
    // already decoded this session? that's free — otherwise wait for real intent
    if (engaged || peaksCached(track)) requestPeaks(track);
  });
  bus.emit('track', { index: audio.index, track: audio.track });

  bus.on('meta', ({ d }) => { tDur.textContent = fmt(d); });

  /* ─────────── frame ─────────── */
  onFrame((dt, time) => {
    const d = audio.duration || 1;
    const p = clamp(audio.currentTime / d);
    displayProgress = damp(displayProgress, p, 22, dt);

    head.style.left = `${displayProgress * 100}%`;
    tCur.textContent = fmt(audio.currentTime);
    scrub.setAttribute('aria-valuenow', Math.round(p * 100));
    scrub.setAttribute('aria-valuetext', `${fmt(audio.currentTime)} of ${fmt(d)}`);
    dkBar.style.width = `${p * 100}%`;

    glow.style.setProperty('--level', state.level.toFixed(3));
    mount.style.setProperty('--level', state.level.toFixed(3));

    drawWave(canvas, peaks, displayProgress, {
      accent: audio.track.accent,
      level: state.level,
      hover: hoverRatio,
      loading: peaksPending,
      time,
      reducedMotion: state.reducedMotion
    });

    const wantDock = !dockDismissed && dock.dataset.away === 'true' && (state.playing || audio.currentTime > 0);
    dock.classList.toggle('is-up', wantDock);
  });
}
