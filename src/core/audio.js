/**
 * audio.js — the listening engine.
 *
 * One <audio> element routed through a Web Audio graph so the WebGL scenes can
 * react to what's actually playing. Exposes smoothed level/bass/mid/treble and
 * a decaying `beat` spike on transients.
 *
 * The AudioContext is created lazily on the first real user gesture, which is
 * what browsers require and also means we cost nothing until someone presses play.
 */
import { bus, state, onFrame, clamp, damp } from './bus.js';
import { TRACKS } from '../content.js';

const el = new Audio();
el.preload = 'metadata';
el.crossOrigin = 'anonymous';

let ctx = null, analyser = null, source = null, gain = null, freq = null;
let index = 0, wired = false;
let prevLevel = 0;

export const audio = {
  el,
  tracks: TRACKS,
  get index() { return index; },
  get track() { return TRACKS[index]; },
  get playing() { return !el.paused && !el.ended; },
  get duration() { return Number.isFinite(el.duration) ? el.duration : (TRACKS[index]?.duration || 0); },
  get currentTime() { return el.currentTime; },
  get volume() { return el.volume; },

  load(i, { play = false } = {}) {
    index = ((i % TRACKS.length) + TRACKS.length) % TRACKS.length;
    const t = TRACKS[index];
    el.src = t.audio;
    state.accent = t.accent;
    bus.emit('track', { index, track: t });
    if (play) audio.play();
  },

  async play() {
    ensureGraph();
    if (ctx?.state === 'suspended') await ctx.resume();
    try { await el.play(); }
    catch (err) { if (err.name !== 'AbortError') console.warn('[audio] play blocked', err); }
  },

  pause() { el.pause(); },
  toggle() { audio.playing ? audio.pause() : audio.play(); },
  next() { audio.load(index + 1, { play: true }); },
  prev() {
    if (el.currentTime > 4) { el.currentTime = 0; return; }
    audio.load(index - 1, { play: true });
  },
  seek(t) { if (Number.isFinite(t)) el.currentTime = clamp(t, 0, audio.duration || 0); },
  seekBy(d) { audio.seek(el.currentTime + d); },
  setVolume(v) { el.volume = clamp(v); bus.emit('volume', el.volume); }
};

/** Build the Web Audio graph. Safe to call repeatedly. */
function ensureGraph() {
  if (ctx) return;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;                       // no Web Audio: playback still works, reactivity doesn't
  try {
    ctx = new AC();
    source = ctx.createMediaElementSource(el);
    gain = ctx.createGain();
    analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.72;
    analyser.minDecibels = -85;
    analyser.maxDecibels = -12;
    source.connect(gain); gain.connect(analyser); analyser.connect(ctx.destination);
    freq = new Uint8Array(analyser.frequencyBinCount);
  } catch (err) {
    console.warn('[audio] analyser unavailable', err);
    ctx = null; analyser = null;
  }
}

/** Average a slice of the FFT, 0..1. */
function band(from, to) {
  let sum = 0;
  for (let i = from; i < to; i++) sum += freq[i];
  return sum / ((to - from) * 255);
}

onFrame((dt) => {
  state.playing = audio.playing;

  if (analyser && state.playing) {
    analyser.getByteFrequencyData(freq);
    const n = freq.length;                    // 512 bins ≈ 0–22kHz
    const bass   = band(1, Math.floor(n * 0.06));
    const mid    = band(Math.floor(n * 0.06), Math.floor(n * 0.28));
    const treble = band(Math.floor(n * 0.28), Math.floor(n * 0.72));
    const level  = clamp(bass * 0.55 + mid * 0.32 + treble * 0.13);

    state.bass   = damp(state.bass,   bass,   14, dt);
    state.mid    = damp(state.mid,    mid,    14, dt);
    state.treble = damp(state.treble, treble, 16, dt);
    state.level  = damp(state.level,  level,  12, dt);

    // transient detection: a rise in level above the running average fires a beat
    const rise = level - prevLevel;
    if (rise > 0.045) state.beat = Math.min(1, state.beat + rise * 5);
    prevLevel = level;
  } else {
    state.bass   = damp(state.bass,   0, 3, dt);
    state.mid    = damp(state.mid,    0, 3, dt);
    state.treble = damp(state.treble, 0, 3, dt);
    state.level  = damp(state.level,  0, 3, dt);
  }
  state.beat = damp(state.beat, 0, 6, dt);
});

/* ---------- element events ---------- */
if (!wired) {
  wired = true;
  el.addEventListener('play',       () => bus.emit('playstate', true));
  el.addEventListener('pause',      () => bus.emit('playstate', false));
  el.addEventListener('ended',      () => audio.next());
  el.addEventListener('timeupdate', () => bus.emit('time', { t: el.currentTime, d: audio.duration }));
  el.addEventListener('loadedmetadata', () => bus.emit('meta', { d: audio.duration }));
  el.addEventListener('error', () => {
    console.warn('[audio] failed to load', TRACKS[index]?.audio);
    bus.emit('audioerror', TRACKS[index]);
  });
  el.volume = 0.72;
  audio.load(0);
}

/* ---------- OS media controls ---------- */
bus.on('track', ({ track }) => {
  if (!('mediaSession' in navigator)) return;
  // Guarded: URL resolution throws in sandboxed/srcdoc frames (base is
  // 'about:srcdoc'), and metadata is a nicety — never let it throw on a
  // track change.
  try {
    let art = [];
    try { art = [{ src: new URL(track.art, document.baseURI).href, sizes: '512x512' }]; } catch {}
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title,
      artist: track.artist,
      album: 'Produced & mixed by Shane J. M. Brower',
      artwork: art
    });
  } catch (err) { console.warn('[audio] mediaSession metadata skipped', err); }
});
if ('mediaSession' in navigator) {
  const ms = navigator.mediaSession;
  const safe = (fn) => () => { try { fn(); } catch {} };
  ms.setActionHandler('play',         safe(() => audio.play()));
  ms.setActionHandler('pause',        safe(() => audio.pause()));
  ms.setActionHandler('nexttrack',    safe(() => audio.next()));
  ms.setActionHandler('previoustrack',safe(() => audio.prev()));
  ms.setActionHandler('seekbackward', safe(() => audio.seekBy(-10)));
  ms.setActionHandler('seekforward',  safe(() => audio.seekBy(10)));
}
