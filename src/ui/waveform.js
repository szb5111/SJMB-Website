/**
 * waveform.js — real peak data, drawn on canvas.
 *
 * Peaks are decoded once per track from the same file the <audio> element is
 * already downloading (so it comes out of the HTTP cache), downsampled to a
 * fixed bucket count, then kept in memory and sessionStorage. Until the real
 * data lands we draw a deterministic placeholder derived from the track id, so
 * the component never shows an empty box or shifts layout.
 *
 * The drawing side is deliberately DAW-like: an asymmetric body with a short
 * reflection, a vertical gradient so bars read as lit from above, a hard
 * played/unplayed split, a hover-preview range, and a level-reactive bloom
 * around the playhead.
 */
const BUCKETS = 900;
const CACHE_V = 'v4';            // bump to invalidate stale, flatter cached peaks
const memo = new Map();
const inflight = new Map();

/* ─────────────────────────────────────────────────────────────
   PEAKS
   ───────────────────────────────────────────────────────────── */

/**
 * Deterministic stand-in so the scrubber is never blank.
 * Built from song-shaped sections (intro / verse / chorus / bridge / outro)
 * rather than noise, so the placeholder reads as music, not as a grey band.
 */
export function placeholderPeaks(seedStr) {
  let s = 2166136261;
  for (let i = 0; i < seedStr.length; i++) s = (Math.imul(s ^ seedStr.charCodeAt(i), 16777619)) >>> 0;
  const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };

  // A plausible arrangement: level per section, plus a couple of breakdowns.
  const sections = [
    { len: 0.08, lvl: 0.30 },   // intro
    { len: 0.16, lvl: 0.62 },   // verse
    { len: 0.14, lvl: 0.94 },   // chorus
    { len: 0.15, lvl: 0.66 },   // verse
    { len: 0.13, lvl: 0.97 },   // chorus
    { len: 0.10, lvl: 0.38 },   // breakdown
    { len: 0.16, lvl: 1.00 },   // final chorus
    { len: 0.08, lvl: 0.34 }    // outro
  ];
  // section boundaries in bucket space
  const edges = [];
  let acc = 0;
  for (const sec of sections) { acc += sec.len; edges.push(acc); }
  const total = acc;

  const out = new Float32Array(BUCKETS);
  let env = 0;
  for (let i = 0; i < BUCKETS; i++) {
    const t = (i / BUCKETS) * total;
    let si = 0;
    while (si < edges.length - 1 && t > edges[si]) si++;
    const sec = sections[si];
    const prev = si === 0 ? 0 : edges[si - 1];
    const local = (t - prev) / Math.max(1e-4, sec.len);

    // ease into each section so transitions read as arrangement, not steps
    const ease = local < 0.06 ? local / 0.06 : 1;
    const prevLvl = si === 0 ? 0.12 : sections[si - 1].lvl;
    let target = prevLvl + (sec.lvl - prevLvl) * (ease * ease * (3 - 2 * ease));

    // bar-level pulse (roughly 4 hits per section eighth) + grain
    target *= 0.80 + 0.20 * Math.abs(Math.sin(t * Math.PI * 46));
    target *= 0.86 + rnd() * 0.28;

    // occasional transient stab and the odd near-silent beat
    if (rnd() > 0.982) target *= 1.28;
    if (rnd() > 0.994) target *= 0.28;

    env = env * 0.55 + target * 0.45;                  // slew, so it isn't hairy noise
    out[i] = Math.max(0.035, Math.min(1, env));
  }
  out.placeholder = true;
  return out;
}

/**
 * True when this track's real peaks can be had without touching the network
 * (already in memory, or in sessionStorage from earlier in the visit).
 * Lets the player upgrade the waveform for free, and only pay the download
 * once the visitor has actually engaged.
 */
export function peaksCached(track) {
  if (memo.has(track.id)) return true;
  try { return sessionStorage.getItem(`peaks:${CACHE_V}:${track.id}:${BUCKETS}`) != null; }
  catch { return false; }
}

export async function loadPeaks(track) {
  if (memo.has(track.id)) return memo.get(track.id);
  if (inflight.has(track.id)) return inflight.get(track.id);

  const cacheKey = `peaks:${CACHE_V}:${track.id}:${BUCKETS}`;
  try {
    const cached = sessionStorage.getItem(cacheKey);
    if (cached) {
      const arr = Float32Array.from(JSON.parse(cached));
      if (arr.length === BUCKETS) { memo.set(track.id, arr); return arr; }
    }
  } catch { /* private mode — just decode again */ }

  const job = (async () => {
    const AC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!AC) return placeholderPeaks(track.id);
    try {
      const res = await fetch(track.audio);
      if (!res.ok) throw new Error(res.status);
      const buf = await res.arrayBuffer();
      const ctx = new AC(1, 1, 44100);
      const decoded = await ctx.decodeAudioData(buf);
      const peaks = downsample(decoded);
      memo.set(track.id, peaks);
      try { sessionStorage.setItem(cacheKey, JSON.stringify([...peaks].map((v) => +v.toFixed(3)))); } catch {}
      return peaks;
    } catch (err) {
      console.warn('[waveform] falling back to placeholder for', track.id, err);
      const p = placeholderPeaks(track.id);
      memo.set(track.id, p);
      return p;
    } finally {
      inflight.delete(track.id);
    }
  })();

  inflight.set(track.id, job);
  return job;
}

function downsample(audioBuffer) {
  const chs = Math.min(2, audioBuffer.numberOfChannels);
  const a = audioBuffer.getChannelData(0);
  const b = chs > 1 ? audioBuffer.getChannelData(1) : null;
  const len = a.length;
  const step = Math.max(1, Math.floor(len / BUCKETS));
  const out = new Float32Array(BUCKETS);

  for (let i = 0; i < BUCKETS; i++) {
    const start = i * step;
    const end = Math.min(start + step, len);
    let peak = 0, sum = 0, n = 0;
    // stride through the bucket rather than every sample — visually identical, ~4× faster
    for (let j = start; j < end; j += 3) {
      const v = b ? (Math.abs(a[j]) + Math.abs(b[j])) * 0.5 : Math.abs(a[j]);
      if (v > peak) peak = v;
      sum += v * v; n++;
    }
    const rms = n ? Math.sqrt(sum / n) : 0;
    // peak alone is spiky and flat-topped; a little RMS restores the song's body
    out[i] = peak * 0.72 + rms * 0.62;
  }

  // Modern masters are heavily limited, so raw peaks draw as one flat slab.
  // Stretch between a low and a high percentile instead of normalising to the
  // max: the quiet floor drops to nothing, choruses reach the ceiling, and the
  // arrangement becomes legible again.
  const sorted = Float32Array.from(out).sort();
  const lo = sorted[Math.floor(BUCKETS * 0.06)] || 0;
  const hi = sorted[Math.floor(BUCKETS * 0.99)] || sorted[BUCKETS - 1] || 1;
  const span = Math.max(1e-4, hi - lo * 0.92);

  for (let i = 0; i < BUCKETS; i++) {
    const v = Math.max(0, (out[i] - lo * 0.92) / span);
    out[i] = Math.max(0.04, Math.min(1, 0.08 + 0.92 * Math.pow(Math.min(1, v), 0.92)));
  }
  return out;
}

/* ─────────────────────────────────────────────────────────────
   DRAWING
   ───────────────────────────────────────────────────────────── */

const HEX = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i;
function rgbOf(hex) {
  const m = HEX.exec(String(hex).trim());
  if (!m) return [255, 154, 90];
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
}
const mix = (c1, c2, t) => [
  Math.round(c1[0] + (c2[0] - c1[0]) * t),
  Math.round(c1[1] + (c2[1] - c1[1]) * t),
  Math.round(c1[2] + (c2[2] - c1[2]) * t)
];
const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

const BONE = [244, 237, 226];
const gradCache = new Map();

/** Cached vertical gradients — rebuilding these every frame is pure waste. */
function gradients(g, accent, top, mid, refBottom) {
  const key = `${accent}|${top.toFixed(1)}|${mid.toFixed(1)}|${refBottom.toFixed(1)}`;
  const hit = gradCache.get(key);
  if (hit) return hit;

  const acc = rgbOf(accent);
  const hot = mix(acc, [255, 255, 255], 0.42);
  const deep = mix(acc, [10, 16, 13], 0.28);

  const body = g.createLinearGradient(0, top, 0, mid);
  body.addColorStop(0, rgba(hot, 1));
  body.addColorStop(0.42, rgba(acc, 1));
  body.addColorStop(1, rgba(deep, 1));

  const bodyRef = g.createLinearGradient(0, mid, 0, refBottom);
  bodyRef.addColorStop(0, rgba(acc, 0.5));
  bodyRef.addColorStop(1, rgba(deep, 0.04));

  const rest = g.createLinearGradient(0, top, 0, mid);
  rest.addColorStop(0, rgba(BONE, 0.32));
  rest.addColorStop(0.55, rgba(BONE, 0.19));
  rest.addColorStop(1, rgba(BONE, 0.10));

  const restRef = g.createLinearGradient(0, mid, 0, refBottom);
  restRef.addColorStop(0, rgba(BONE, 0.11));
  restRef.addColorStop(1, rgba(BONE, 0.015));

  const ahead = g.createLinearGradient(0, top, 0, mid);
  ahead.addColorStop(0, rgba(BONE, 0.62));
  ahead.addColorStop(0.55, rgba(BONE, 0.44));
  ahead.addColorStop(1, rgba(BONE, 0.26));

  const aheadRef = g.createLinearGradient(0, mid, 0, refBottom);
  aheadRef.addColorStop(0, rgba(BONE, 0.22));
  aheadRef.addColorStop(1, rgba(BONE, 0.03));

  const out = { body, bodyRef, rest, restRef, ahead, aheadRef, acc, hot };
  if (gradCache.size > 40) gradCache.clear();
  gradCache.set(key, out);
  return out;
}

/**
 * Draw the scrubber.
 * @param {HTMLCanvasElement} canvas
 * @param {Float32Array} peaks   0..1 magnitudes
 * @param {number} progress      0..1 played fraction
 * @param {object} opts          { accent, level, hover, loading, time, reducedMotion }
 */
export function drawWave(canvas, peaks, progress, opts = {}) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h || !peaks || !peaks.length) return;

  const {
    accent = '#ff9a5a',
    level = 0,
    hover = -1,
    loading = false,
    time = 0,
    reducedMotion = false
  } = opts;

  // Cheap dirty check — the frame loop calls this at 60fps whether or not
  // anything has actually moved.
  const anim = loading && !reducedMotion ? Math.round(time * 24) : 0;
  const sig = `${w}x${h}@${dpr}|${accent}|${progress.toFixed(4)}|${level.toFixed(3)}|${hover.toFixed(3)}|${loading ? 1 : 0}|${anim}`;
  if (canvas.__wfSig === sig && canvas.__wfPeaks === peaks) return;
  canvas.__wfSig = sig;
  canvas.__wfPeaks = peaks;

  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);

  /* ---- geometry ---- */
  const compact = w < 420;
  const unit = compact ? 3 : 4;                 // bar pitch, css px
  const barW = compact ? 2 : 2.5;
  const bars = Math.max(8, Math.floor(w / unit));
  const mid = Math.round(h * 0.70) + 0.5;       // baseline low, reflection below
  const topH = mid - 2;
  const refH = h - mid - 2;
  const per = peaks.length / bars;

  const gr = gradients(g, accent, mid - topH, mid, mid + refH);
  const playedX = progress * w;
  const hoverX = hover >= 0 ? hover * w : -1;
  const aheadTo = hoverX > playedX ? hoverX : -1;   // SoundCloud-style preview range
  const fade = loading ? 0.62 : 1;

  /* ---- baseline hairline ---- */
  g.fillStyle = rgba(BONE, 0.07);
  g.fillRect(0, mid, w, 1);

  /* ---- bars ---- */
  for (let i = 0; i < bars; i++) {
    const x = i * unit;
    const from = Math.floor(i * per);
    const to = Math.max(from + 1, Math.floor((i + 1) * per));
    let p = 0;
    for (let j = from; j < to && j < peaks.length; j++) if (peaks[j] > p) p = peaks[j];

    // live bounce on the bars nearest the playhead — the waveform breathes
    const near = 1 - Math.min(1, Math.abs(x - playedX) / (unit * 9));
    const amp = Math.min(1, p * (1 + near * near * level * 0.7));

    const bh = Math.max(2, amp * topH);
    const rh = Math.max(1.5, amp * refH * 0.72);
    const played = x <= playedX;
    const isAhead = !played && aheadTo > 0 && x <= aheadTo;

    g.globalAlpha = fade;
    g.fillStyle = played ? gr.body : isAhead ? gr.ahead : gr.rest;
    roundBar(g, x, mid - bh, barW, bh);

    g.globalAlpha = fade * 0.9;
    g.fillStyle = played ? gr.bodyRef : isAhead ? gr.aheadRef : gr.restRef;
    roundBar(g, x, mid + 2, barW, rh);
  }
  g.globalAlpha = 1;

  /* ---- level bloom around the playhead ---- */
  if (level > 0.01 && playedX > 0) {
    const r = 26 + level * 90;
    const bloom = g.createRadialGradient(playedX, mid - topH * 0.45, 0, playedX, mid - topH * 0.45, r);
    bloom.addColorStop(0, rgba(gr.hot, 0.16 + level * 0.3));
    bloom.addColorStop(1, rgba(gr.hot, 0));
    g.globalCompositeOperation = 'lighter';
    g.fillStyle = bloom;
    g.fillRect(playedX - r, 0, r * 2, h);
    g.globalCompositeOperation = 'source-over';
  }

  /* ---- decode-in-progress shimmer ---- */
  if (loading && !reducedMotion) {
    const sweep = ((time * 0.42) % 1.4) - 0.2;      // -0.2 → 1.2
    const cx = sweep * w;
    const band = g.createLinearGradient(cx - w * 0.22, 0, cx + w * 0.22, 0);
    band.addColorStop(0, rgba(BONE, 0));
    band.addColorStop(0.5, rgba(BONE, 0.10));
    band.addColorStop(1, rgba(BONE, 0));
    g.globalCompositeOperation = 'lighter';
    g.fillStyle = band;
    g.fillRect(0, 0, w, h);
    g.globalCompositeOperation = 'source-over';
  }
}

function roundBar(g, x, y, w, h) {
  const r = Math.min(w / 2, h / 2);
  g.beginPath();
  if (g.roundRect) g.roundRect(x, y, w, h, r);
  else g.rect(x, y, w, h);
  g.fill();
}
