/**
 * hero.js — "Two Signals": slow intersecting audio waves in the void.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE IDEA
 *
 * Seven waveform strands — some ember, some tide — flow horizontally across the
 * hero like traces on a mastering-suite scope, phase-drifting so slowly that a
 * single second shows almost nothing and ten seconds are hypnotic. Where an
 * ember strand crosses a tide strand the additive overlap sums toward a warm
 * near-white and blooms: two voices meeting. That crossing glow is the whole
 * scene.
 *
 * THE MATHS
 *
 * Each strand s is a superposition of three sinusoids with deliberately
 * incommensurate spatial frequencies (so the shape never visibly repeats):
 *
 *   y_s(x, t) = c_s(t) + E(x) · G · [ a1·sin(k1·x + w1·t + p1)
 *                                   + a2·sin(k2·x + w2·t + p2)
 *                                   + a3·sin(k3·x + w3·t + p3) ]
 *
 *   x  ∈ [-1, 1]  normalised across the frame
 *   c_s(t) = y0 + dA·sin(dW·t + dP)      — the vertical centre itself drifts
 *            (periods of minutes, so the crossings migrate)
 *   E(x)   — amplitude envelope: waves swell mid-frame, thin to the edges
 *   G      — global amplitude gain (idle breath + music level; bass feeds the
 *            k1 component only, treble adds a fine extra ripple)
 *   w_i    — phase drift speeds, ~0.06..0.12 rad/s: 50–100 s per cycle
 *
 * Every parameter is hand-authored per strand (below) and baked into vertex
 * attributes, so the whole field renders as ONE THREE.Points draw call. Each
 * particle carries (t-along-strand, a gaussian across-strand offset, depth) in
 * `position` and evaluates the curve in the vertex shader. The gaussian offset
 * gives each ribbon a soft thickness — tight and bright at the core, wide and
 * dim at the halo — so the strands read as light, not vector lines.
 *
 * CROSSINGS
 *
 * The bloom at intersections is mostly free: additive blending of ember
 * (1.0, .60, .35) over tide (.50, .71, 1.0) approaches warm white and clears
 * the bloom threshold exactly where two ribbons overlap. On top of that, the
 * CPU mirrors the curve maths (evalStrandY below — keep it in sync with the
 * shader!), finds the actual ember×tide intersection points a few times a
 * second, and hands the strongest eight to the shader, which (a) whitens and
 * lifts particles near them slightly and (b) on a musical transient sends a
 * small, fast-decaying ring of brightness travelling outward from each one.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import * as THREE from 'three';

/* ── small maths helpers (local, so this file has no cross-module coupling) ── */
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, t) => a + (b - a) * t;
/** Frame-rate independent damping. Every animated value goes through this. */
const damp = (a, b, lambda, dt) => lerp(a, b, 1 - Math.exp(-lambda * dt));
const smoothstep = (e0, e1, x) => { const t = clamp01((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };
const mapc = (v, a, b, c, d) => lerp(c, d, clamp01((v - a) / (b - a)));

/* ── The strand table ──────────────────────────────────────────────────────
 * Hand-authored characters. Units: y0/dA in world units, k in radians across
 * the half-frame (k = pi is one full wavelength per frame width), w in rad/s.
 *
 *   col     0 = ember, 1 = tide
 *   variant 0..1 mix toward the deep (ember2) / light (tide2) variant
 *   thick   gaussian sigma of the ribbon, world units
 *   gain    brightness weight — the two dimmest strands are scene dressing
 *   rA/rK/rW/rP — audio-waveform character: a fine ripple (rK ~ 6-10x the
 *           base k1) rides the macro curve, its amplitude swelling and dying
 *           via a product of two incommensurate slow sinusoids in (x, t) so
 *           the strand reads like a waveform trace of programme material.
 *           rA = 0 disables it; four of seven carry it so the two characters
 *           (smooth signal vs. waveform trace) contrast. Distinct from the
 *           audio-reactive uTreble ripple, which stays separate seasoning.
 *
 * Frequencies are incommensurate on purpose (5.23/3.1, 8.47/5.23 ... are all
 * irrational-ish ratios) so no strand's shape ever visibly loops.           */
const STRANDS = [
  //  col  y0     dA    dW     dP   z      k1    k2    k3     a1    a2    a3     w1      w2      w3     p1   p2   p3   gain  thick variant   rA    rK    rW     rP
  { col: 0, y0:  1.26, dA: 0.55, dW: 0.021, dP: 0.0, z: -1.10, k: [3.10, 5.23, 8.47], a: [0.62, 0.27, 0.11], w: [ 0.083, -0.061,  0.114], p: [0.0, 2.1, 4.4], gain: 1.00, thick: 0.085, variant: 0.00, rA: 0.16, rK: 23.7, rW:  0.087, rP: 1.7 },
  { col: 1, y0:  0.70, dA: 0.62, dW: 0.016, dP: 2.1, z:  0.60, k: [2.60, 4.41, 7.83], a: [0.70, 0.24, 0.10], w: [-0.072,  0.097, -0.053], p: [1.3, 5.0, 0.7], gain: 0.95, thick: 0.095, variant: 0.15, rA: 0.18, rK: 21.1, rW: -0.064, rP: 4.2 },
  { col: 0, y0:  0.10, dA: 0.48, dW: 0.026, dP: 4.0, z:  1.15, k: [3.70, 6.19, 9.31], a: [0.52, 0.30, 0.09], w: [ 0.066,  0.091, -0.079], p: [3.9, 1.6, 2.8], gain: 0.88, thick: 0.075, variant: 0.55, rA: 0.15, rK: 27.3, rW:  0.071, rP: 0.6 },
  { col: 1, y0: -0.46, dA: 0.58, dW: 0.019, dP: 1.2, z: -0.35, k: [2.90, 5.77, 8.99], a: [0.66, 0.22, 0.12], w: [-0.094,  0.058,  0.076], p: [5.6, 3.3, 1.1], gain: 1.00, thick: 0.090, variant: 0.00, rA: 0.17, rK: 25.9, rW: -0.078, rP: 3.1 },
  { col: 0, y0: -1.06, dA: 0.52, dW: 0.023, dP: 5.3, z:  0.25, k: [3.40, 4.87, 7.41], a: [0.58, 0.26, 0.10], w: [ 0.077, -0.105,  0.049], p: [2.4, 0.5, 5.9], gain: 0.92, thick: 0.080, variant: 0.25, rA: 0,    rK: 0,    rW: 0,      rP: 0   },
  { col: 1, y0: -1.62, dA: 0.60, dW: 0.014, dP: 3.6, z: -0.85, k: [2.30, 5.03, 9.67], a: [0.72, 0.20, 0.09], w: [-0.062,  0.084, -0.112], p: [4.7, 2.9, 3.5], gain: 0.78, thick: 0.105, variant: 0.60, rA: 0,    rK: 0,    rW: 0,      rP: 0   },
  { col: 1, y0:  1.86, dA: 0.50, dW: 0.018, dP: 0.8, z:  0.95, k: [2.10, 6.53, 8.11], a: [0.55, 0.18, 0.08], w: [ 0.069, -0.051,  0.089], p: [0.9, 4.2, 1.9], gain: 0.70, thick: 0.115, variant: 0.35, rA: 0,    rK: 0,    rW: 0,      rP: 0   }
];
const NS = STRANDS.length;
const NCROSS = 8;          // crossing points handed to the shader
const STILL_TIME = 21.0;   // frozen phase for reduced motion (several crossings live)

/* ── Shaders ──────────────────────────────────────────────────────────────── */

const VERT = /* glsl */`
precision highp float;

uniform float uTime;
uniform float uSpanX;      // half-width of the strand field, world units
uniform float uYOff;       // vertical placement of the whole field
uniform float uAmp;        // global amplitude gain (idle breath + level)
uniform float uBass;       // 0..1 -> swells the k1 (lowest) component only
uniform float uTreble;     // 0..1 -> fine high-frequency ripple on top
uniform float uLevel;
uniform float uBeat;       // fast-decaying transient envelope
uniform float uBeatR;      // radius of the ring travelling out of crossings
uniform float uOpacity;
uniform float uSize;       // base point size, world units
uniform float uPixelScale; // (framebufferHeight / 2) / tan(fov / 2)
uniform vec2  uDimEdge;    // smoothstep edges of the left-side dimming ramp
uniform float uDimFloor;   // brightness floor under the headline column
uniform vec3  uCross[8];   // (x, y, weight) of ember x tide intersections

// position: x = t along strand (0..1), y = gaussian across-strand offset
//           (sigma = 1, clamped to +-2.6), z = strand depth stagger
attribute vec4 aSeed;      // x size, y brightness, z twinkle phase, w unused
attribute vec4 aK;         // k1 k2 k3, thick (gaussian sigma, world units)
attribute vec4 aA;         // a1 a2 a3, gain
attribute vec4 aW;         // w1 w2 w3, colour flag (0 ember, 1 tide)
attribute vec4 aP;         // p1 p2 p3, variant (mix toward deep/light)
attribute vec4 aC;         // y0, driftAmp, driftSpeed, driftPhase
attribute vec4 aR;         // ripple: amp, k, drift speed, phase (amp 0 = none)

varying vec3  vColor;
varying float vAlpha;

/* Display-referred sRGB literals, on purpose: the post chain has no
   linear-to-sRGB encode, so linear-space palette colours would come out
   crushed. These ARE the brand hexes, as 0..1 floats. */
const vec3 EMBER   = vec3(1.000, 0.604, 0.353);   // #ff9a5a
const vec3 EMBER_D = vec3(0.949, 0.455, 0.227);   // #f2743a
const vec3 TIDE    = vec3(0.498, 0.706, 1.000);   // #7fb4ff
const vec3 TIDE_L  = vec3(0.663, 0.839, 0.933);   // #a9d6ee
const vec3 BONE    = vec3(0.957, 0.929, 0.886);   // #f4ede2 - crossings only

/* Amplitude envelope: swell mid-frame, feather to nothing past the edges. */
float envAmp(float x) {
  return smoothstep(-1.12, -0.42, x) * (1.0 - smoothstep(0.55, 1.12, x));
}

void main() {
  float xn = position.x * 2.0 - 1.0;       // -1..1 across the frame
  float env = envAmp(xn);

  /* -- The wave: three superposed sinusoids, see the file header ----------- */
  float a1 = aA.x * (1.0 + uBass * 0.55);  // bass swells ONLY the lowest mode
  float s1 = a1   * sin(aK.x * xn + uTime * aW.x + aP.x);
  float s2 = aA.y * sin(aK.y * xn + uTime * aW.y + aP.y);
  float s3 = aA.z * sin(aK.z * xn + uTime * aW.z + aP.z);
  float wave = env * uAmp * (s1 + s2 + s3);

  /* Audio-waveform character (static, per-strand; aR.x = 0 on smooth strands):
     a fine oscillation whose amplitude swells and dies along the trace like
     programme material. The envelope is a product of two incommensurate slow
     sinusoids in (x, t) - deterministic, drifting as slowly as everything
     else. MUST match evalStrandY on the CPU exactly. */
  float re = sin(1.9 * xn + uTime * 0.041 + aR.w * 1.7)
           * sin(3.1 * xn - uTime * 0.027 + aR.w * 0.6);
  float wave2 = env * uAmp * aR.x * re * sin(aR.y * xn + uTime * aR.z + aR.w);
  wave += wave2;

  // Treble: a fine, fast ripple riding on top. Tiny; seasoning, not the meal.
  wave += env * uTreble * 0.09 * sin(16.0 * xn + uTime * 1.7 + aP.x * 3.0);

  // Normalised crest measure, so an occasional swell can clear the bloom
  // threshold while the body of the strand stays under it. Normalised by the
  // SWOLLEN a1: bass then adds geometry (bigger waves), not a blanket
  // brightness lift across the whole strand.
  float crest = abs(s1 + s2 + s3) / (a1 + aA.y + aA.z + 1e-4);

  /* Vertical centre drift: minutes per cycle, migrates the crossings. */
  float yc = aC.x + aC.y * sin(uTime * aC.z + aC.w);

  /* Left-side discipline: under the headline column the strands run dim AND
     thin so the type owns the left. The ramp edges come from resize()
     (disabled entirely in portrait, where the type sits above the field). */
  float dim = uDimFloor + (1.0 - uDimFloor) * smoothstep(uDimEdge.x, uDimEdge.y, xn);

  /* Ribbon thickness: the gaussian across-strand offset (position.y) scaled
     by the strand sigma, thinner on the dim side. The 0.75 narrows every
     ribbon ~25 percent versus the authored sigmas (client note) without
     touching sprite size, so the soft-edge character survives. */
  float g = position.y;
  float off = g * aK.w * 0.75 * (0.6 + 0.4 * dim);

  vec2 curve = vec2(xn * uSpanX, yc + wave);        // crossing-space position
  vec3 local = vec3(curve.x, curve.y + uYOff + off, position.z);

  /* -- Crossings: whiten + lift near them, and let the beat ring ripple out.
     uCross y-values live in the same pre-uYOff space as the curve. Unused
     slots have weight 0 and sit at x = 1e5 so they contribute nothing.     */
  float meet = 0.0;
  float ring = 0.0;
  for (int i = 0; i < 8; i++) {
    vec3 c = uCross[i];
    float d = distance(curve, c.xy);
    meet += c.z * exp(-d * d * 1.6);
    ring += c.z * exp(-(d - uBeatR) * (d - uBeatR) * 5.0);
  }
  meet = min(meet, 1.4);

  vec4 mv = modelViewMatrix * vec4(local, 1.0);
  gl_Position = projectionMatrix * mv;

  /* -- Colour: each strand is EITHER ember or tide (aW.w), pulled toward its
     deep/light variant by aP.w. Near-white lives ONLY at the crossings. */
  vec3 col = mix(mix(EMBER, EMBER_D, aP.w), mix(TIDE, TIDE_L, aP.w), aW.w);
  col = mix(col, BONE, clamp(meet, 0.0, 1.0) * 0.45);

  /* -- Brightness ---------------------------------------------------------
     gauss   - the ribbon profile: bright core, wide dim halo
     edge    - feather out at the frame edges
     crestUp - only the top ~third of a swell brightens (bloom picks crests)
     meet/ring - the intersections are the light                             */
  float gauss   = exp(-g * g * 2.0);
  float edge    = 1.0 - smoothstep(0.86, 1.04, abs(xn));
  float crestUp = 1.0 + smoothstep(0.62, 0.96, crest) * 0.55;
  float twinkle = 0.92 + 0.08 * sin(uTime * 0.5 + aSeed.z * 6.2831853);

  float lum = aA.w * (0.45 + 0.90 * aSeed.y) * gauss * dim * edge * crestUp * twinkle;
  lum *= 1.0 + meet * 1.35 + uBeat * ring * 1.3;
  lum *= 1.0 + uLevel * 0.12;

  vColor = col;
  vAlpha = uOpacity * lum * 0.36;

  /* -- Size: halo particles are bigger and (via gauss above) dimmer, which is
     what turns a particle row into a soft ribbon of light. Perspective
     attenuation: world length L at depth d covers L/d * uPixelScale px.   */
  float sz = uSize * (0.6 + 0.8 * aSeed.x) * (1.0 + abs(g) * 0.35) * (1.0 + meet * 0.25);
  gl_PointSize = clamp(sz * uPixelScale / max(-mv.z, 0.001), 1.0, 26.0);
}
`;

const FRAG = /* glsl */`
precision highp float;

varying vec3  vColor;
varying float vAlpha;

void main() {
  /* Soft round sprite: tight bright core + wide dim halo, feathered to zero
     at the sprite edge so nothing ever reads as a disc or a quad. */
  float d = length(gl_PointCoord - 0.5) * 2.0;
  if (d > 1.0) discard;

  float core = exp(-d * d * 5.5);
  float halo = exp(-d * d * 1.8) * 0.52;
  float i = (core + halo) * (1.0 - smoothstep(0.68, 1.0, d));

  gl_FragColor = vec4(vColor * i, vAlpha);
}
`;

/* ── CPU mirror of the strand curve ───────────────────────────────────────
 * MUST match the vertex shader's wave maths (minus the treble ripple, whose
 * amplitude is negligible for intersection-finding). Used to locate the
 * ember x tide crossings that the shader whitens and rings.                */
function evalStrandY(s, xn, t, ampGain, bass) {
  const env = smoothstep(-1.12, -0.42, xn) * (1 - smoothstep(0.55, 1.12, xn));
  const a1 = s.a[0] * (1 + bass * 0.55);
  let w =
    a1     * Math.sin(s.k[0] * xn + t * s.w[0] + s.p[0]) +
    s.a[1] * Math.sin(s.k[1] * xn + t * s.w[1] + s.p[1]) +
    s.a[2] * Math.sin(s.k[2] * xn + t * s.w[2] + s.p[2]);
  // Waveform-character ripple: identical to the shader term (envelope =
  // product of two incommensurate slow sinusoids), else crossings drift
  // off the visible curves on the rippled strands.
  if (s.rA > 0) {
    const re = Math.sin(1.9 * xn + t * 0.041 + s.rP * 1.7) *
               Math.sin(3.1 * xn - t * 0.027 + s.rP * 0.6);
    w += s.rA * re * Math.sin(s.rK * xn + t * s.rW + s.rP);
  }
  return s.y0 + s.dA * Math.sin(t * s.dW + s.dP) + env * ampGain * w;
}

/* ── Scene module ─────────────────────────────────────────────────────────── */

let ctxRef = null;
let group = null;      // framing: rake, parallax
let points = null;
let geometry = null;
let material = null;
let uniforms = null;
let onPointer = null;

// animation state (all damped, all frame-rate independent)
let opacity = 0, intro = 0;
let ampCur = 0.9;
let beatEnv = 0, beatPrev = 0, beatT = 9;
let mx = 0, my = 0, mxT = 0, myT = 0;   // mouse parallax, current + target
let dolly = 0;
let narrow = false;   // w <= 780: stacked-type layout, calmer field
let baseOpacity = 1, spanX = 9.5;
let dimEdge0 = -0.62, dimEdge1 = 0.28, dimFloor = 0.16;
let crossTimer = 0;
const crossScratch = [];               // reused per recompute, no per-frame GC

/** Find ember x tide intersections and hand the strongest NCROSS to the GPU.
 *  Cheap: 12 colour-pairs x 40 samples of a few sines, a few times a second. */
function updateCrossings(t, ampGain, bass) {
  crossScratch.length = 0;
  const X0 = -0.55, X1 = 1.0, STEPS = 40;   // bias the scan right-of-centre
  for (let i = 0; i < NS; i++) {
    if (STRANDS[i].col !== 0) continue;
    for (let j = 0; j < NS; j++) {
      if (STRANDS[j].col !== 1) continue;
      let px = X0;
      let pd = evalStrandY(STRANDS[i], px, t, ampGain, bass) -
               evalStrandY(STRANDS[j], px, t, ampGain, bass);
      for (let k = 1; k <= STEPS; k++) {
        const x = X0 + (X1 - X0) * (k / STEPS);
        const d = evalStrandY(STRANDS[i], x, t, ampGain, bass) -
                  evalStrandY(STRANDS[j], x, t, ampGain, bass);
        if ((pd < 0) !== (d < 0)) {
          // sign change -> linear refine to the actual crossing
          const f = pd / (pd - d);
          const cx = lerp(px, x, f);
          const cy = evalStrandY(STRANDS[i], cx, t, ampGain, bass);
          // weight by the same composition ramps the shader uses, so
          // crossings fade in/out rather than popping as they migrate
          const dim = dimFloor + (1 - dimFloor) * smoothstep(dimEdge0, dimEdge1, cx);
          const edge = 1 - smoothstep(0.8, 1.02, Math.abs(cx));
          const w = dim * edge * STRANDS[i].gain * STRANDS[j].gain;
          if (w > 0.02) crossScratch.push([cx * spanX, cy, w]);
        }
        px = x; pd = d;
      }
    }
  }
  crossScratch.sort((a, b) => b[2] - a[2]);
  const arr = uniforms.uCross.value;
  for (let i = 0; i < NCROSS; i++) {
    if (i < crossScratch.length) arr[i].set(crossScratch[i][0], crossScratch[i][1], crossScratch[i][2]);
    else arr[i].set(1e5, 1e5, 0);
  }
}

export default {
  id: 'hero',
  alwaysUpdate: true,   // the waves breathe whether or not the IO has fired

  init(ctx) {
    ctxRef = ctx;
    const { state } = ctx;

    /* ~10k particles per strand at full quality — dense enough that each curve
       reads as a continuous ribbon of light, not a dotted line. Halved on a
       degraded device. */
    const COUNT = state.quality < 1 ? 35000 : 70000;
    const PER = Math.floor(COUNT / NS);

    const pos = new Float32Array(PER * NS * 3);
    const seed = new Float32Array(PER * NS * 4);
    const atK = new Float32Array(PER * NS * 4);
    const atA = new Float32Array(PER * NS * 4);
    const atW = new Float32Array(PER * NS * 4);
    const atP = new Float32Array(PER * NS * 4);
    const atC = new Float32Array(PER * NS * 4);
    const atR = new Float32Array(PER * NS * 4);

    let n = 0;
    for (let si = 0; si < NS; si++) {
      const s = STRANDS[si];
      for (let i = 0; i < PER; i++, n++) {
        // stratified t along the strand: even coverage, organic jitter
        const t = (i + Math.random()) / PER;
        // gaussian across-strand offset, sigma 1 (sum of 3 uniforms), clamped
        let g = (Math.random() + Math.random() + Math.random()) * 2 - 3;
        g = Math.max(-2.6, Math.min(2.6, g));

        pos[n * 3]     = t;
        pos[n * 3 + 1] = g;
        pos[n * 3 + 2] = s.z;
        seed[n * 4]     = Math.random();          // size
        seed[n * 4 + 1] = Math.random();          // brightness
        seed[n * 4 + 2] = Math.random();          // twinkle phase
        seed[n * 4 + 3] = 0;
        atK.set([s.k[0], s.k[1], s.k[2], s.thick], n * 4);
        atA.set([s.a[0], s.a[1], s.a[2], s.gain], n * 4);
        atW.set([s.w[0], s.w[1], s.w[2], s.col], n * 4);
        atP.set([s.p[0], s.p[1], s.p[2], s.variant], n * 4);
        atC.set([s.y0, s.dA, s.dW, s.dP], n * 4);
        atR.set([s.rA, s.rK, s.rW, s.rP], n * 4);
      }
    }

    geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geometry.setAttribute('aSeed', new THREE.BufferAttribute(seed, 4));
    geometry.setAttribute('aK', new THREE.BufferAttribute(atK, 4));
    geometry.setAttribute('aA', new THREE.BufferAttribute(atA, 4));
    geometry.setAttribute('aW', new THREE.BufferAttribute(atW, 4));
    geometry.setAttribute('aP', new THREE.BufferAttribute(atP, 4));
    geometry.setAttribute('aC', new THREE.BufferAttribute(atC, 4));
    geometry.setAttribute('aR', new THREE.BufferAttribute(atR, 4));
    // The vertex shader relocates everything; three's bounds are meaningless.
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 2);

    uniforms = {
      uTime:       { value: 0 },
      uSpanX:      { value: spanX },
      uYOff:       { value: 0 },
      uAmp:        { value: 0.9 },
      uBass:       { value: 0 },
      uTreble:     { value: 0 },
      uLevel:      { value: 0 },
      uBeat:       { value: 0 },
      uBeatR:      { value: 0 },
      uOpacity:    { value: 0 },
      uSize:       { value: 0.036 },
      uPixelScale: { value: 900 },
      uDimEdge:    { value: new THREE.Vector2(dimEdge0, dimEdge1) },
      uDimFloor:   { value: dimFloor },
      uCross:      { value: Array.from({ length: NCROSS }, () => new THREE.Vector3(1e5, 1e5, 0)) }
    };

    material = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: false,            // the world pass shares a depth buffer it did not clear
      blending: THREE.AdditiveBlending
    });

    points = new THREE.Points(geometry, material);
    points.frustumCulled = false;

    /* Framing: raked a few degrees away from the camera — enough that the
       nearer strands drift a whisper faster in parallax, never enough to read
       as "3D tubes". */
    group = new THREE.Group();
    group.rotation.order = 'YXZ';
    group.rotation.x = -0.10;
    group.rotation.y = 0.05;
    group.add(points);
    ctx.world.add(group);

    this.resize(ctx.sizes.w, ctx.sizes.h);

    if (state.reducedMotion) {
      /* One composed still: freeze the clock at a phase where several ember x
         tide crossings sit in the right two-thirds, and never advance it. */
      uniforms.uTime.value = STILL_TIME;
      uniforms.uAmp.value = 0.9;
      intro = 1;
      updateCrossings(STILL_TIME, 0.9, 0);
    } else {
      updateCrossings(0, ampCur, 0);
    }

    /* Mouse parallax — pointer only, a couple of degrees at most. */
    if (!state.coarse) {
      onPointer = (e) => {
        mxT = (e.clientX / window.innerWidth) * 2 - 1;
        myT = (e.clientY / window.innerHeight) * 2 - 1;
      };
      window.addEventListener('pointermove', onPointer, { passive: true });
    }
  },

  /**
   * Aspect-driven layout. Landscape: the field spans the full width but runs
   * dim/thin under the headline column (left ~55%) and keeps its brightest
   * crossings in the right two-thirds, under the diffuser image band.
   * Portrait: the type stacks on top, so the waves sit lower, span the full
   * width, and the left dimming is switched off.
   */
  resize(w, h) {
    if (!ctxRef || !group) return;
    const aspect = w / Math.max(h, 1);

    // Frustum half-width at the strand plane (camera z = 12, field near 0),
    // overscanned so the envelope feathers off-frame, not at the frame edge.
    const fov = ctxRef.cameraW.fov * Math.PI / 180;
    spanX = Math.tan(fov * 0.5) * 12 * aspect * 1.18;
    uniforms.uSpanX.value = spanX;

    /* Below 780 the type stacks over the upper half of the frame and the
       left-dim ramp is off, so drop the whole field ~0.8 world units: the
       brightest crossings then braid BELOW the lede instead of behind it
       (measured at 390x844: lede bottom sits at y-frac 0.58; the hottest
       crossing pair lands at ~0.58-0.66 after this shift). */
    uniforms.uYOff.value = mapc(aspect, 0.7, 1.7, -1.5, -0.15) - (w <= 780 ? 1.3 : 0);

    /* Additive overdraw scales inversely with frame width: the same 70k
       particles squeeze into a spanX that shrinks with aspect, so a phone
       frame sums to a milky wall at the opacity that reads as delicate
       traces on a desktop. Attenuate energy below aspect ~0.95 (measured:
       390x844 hit mean 118/255 mid-field before this). */
    baseOpacity = mapc(aspect, 0.95, 1.45, 0.9, 1.0)
                * mapc(aspect, 0.45, 0.95, 0.28, 1.0);

    /* The left-dim ramp must agree with the CSS layout, which stacks the
       hero type (freeing the left) at w <= 780px - NOT at aspect 1.0. A
       narrow-but-landscape-layout window (e.g. 830x980) still has the
       headline on the left and needs the ramp.

       Where the type actually ENDS: the H1 scales with vw and the lede is
       capped at 42ch, so from ~800px up to ~1500px the column's right edge
       sits near xn = 0.0..0.1 (55 percent of the frame), only receding on
       very wide screens once the rem cap freezes the type. So the ramp has
       to stay LOW until past xn = 0.1 and open fully by ~0.6 - the old
       (-0.62, 0.28) edges were done ramping before the italic 'd' ended. */
    narrow = w <= 780;
    if (w <= 780) {
      dimEdge0 = -3.0; dimEdge1 = -2.5; dimFloor = 1.0;   // ramp fully open
    } else {
      dimEdge0 = -0.10; dimEdge1 = 0.58;
      dimFloor = mapc(aspect, 0.8, 1.6, 0.26, 0.15);
    }
    uniforms.uDimEdge.value.set(dimEdge0, dimEdge1);
    uniforms.uDimFloor.value = dimFloor;

    /* gl_PointSize is in framebuffer pixels: a world length L at distance d
       covers L/d * (H/2)/tan(fov/2) of them. */
    const dpr = ctxRef.sizes.dpr || 1;
    uniforms.uPixelScale.value = (h * dpr * 0.5) / Math.tan(fov * 0.5);
    uniforms.uSize.value = 0.036 * mapc(aspect, 0.95, 1.9, 0.88, 1.0)
                                 * mapc(aspect, 0.45, 0.95, 0.62, 1.0);

    crossTimer = 0;   // re-weight the crossings for the new composition ramps
  },

  update(ctx, dt, t) {
    if (!group) return;
    const s = ctx.state;
    const rec = ctx.sections.get('hero');
    // Before the first frame lands, hero progress reads 0.5 (section filling
    // the viewport), which is what we want the fade to start from.
    const prog = rec ? rec.progress : 0.5;

    /* ── Scroll: recede and fade as the hero leaves. Narrow screens fade
       sooner and finish sooner: the stacked layout puts the next section
       one short swipe away, and the field must be gone when it arrives. */
    const leave = narrow ? smoothstep(0.50, 0.72, prog) : smoothstep(0.52, 0.95, prog);
    dolly = damp(dolly, leave * 5.5, 4, dt);
    const targetOpacity = baseOpacity * (1 - leave);

    if (s.reducedMotion) {
      opacity = damp(opacity, targetOpacity, 6, dt);
      uniforms.uOpacity.value = opacity;
      group.position.z = -dolly;
      points.visible = opacity > 0.002;
      return;                                   // no time advancement at all
    }

    /* ── Boot fade-in: ~1.5s materialisation, part of the first impression. */
    intro = damp(intro, 1, 1.7, dt);
    opacity = damp(opacity, targetOpacity * intro, 5, dt);
    uniforms.uOpacity.value = opacity;
    points.visible = opacity > 0.002;
    if (!points.visible) return;

    uniforms.uTime.value = t;

    /* ── Amplitude: a slow idle breath keeps the waves alive with the music
       paused; level swells everything, bass reaches the k1 term in-shader. */
    const idle = 0.85 + Math.sin(t * 0.06) * 0.10;
    ampCur = damp(ampCur, idle + s.level * 0.30, 3, dt);
    uniforms.uAmp.value = ampCur;
    uniforms.uBass.value = damp(uniforms.uBass.value, s.bass, 4, dt);
    uniforms.uTreble.value = damp(uniforms.uTreble.value, s.treble, 5, dt);
    uniforms.uLevel.value = damp(uniforms.uLevel.value, s.level, 5, dt);

    /* ── Beat: fast-decaying envelope + a ring radius that travels outward
       from the crossings. A rising edge on state.beat re-launches the ring. */
    beatEnv = Math.max(beatEnv * Math.exp(-6 * dt), s.beat);
    if (s.beat - beatPrev > 0.22) beatT = 0;
    beatPrev = s.beat;
    beatT = Math.min(beatT + dt, 9);
    uniforms.uBeat.value = damp(uniforms.uBeat.value, beatEnv, 9, dt);
    uniforms.uBeatR.value = beatT * 2.8;        // world units/s outward

    /* ── Crossings: recompute a few times a second; they move so slowly that
       4Hz is already sub-pixel per step. */
    crossTimer -= dt;
    if (crossTimer <= 0) {
      crossTimer = 0.25;
      updateCrossings(t, ampCur, uniforms.uBass.value);
    }

    /* ── Framing: breathing rake + damped mouse parallax, a few degrees max. */
    mx = damp(mx, mxT, 2.2, dt);
    my = damp(my, myT, 2.2, dt);
    group.rotation.x = -0.10 + Math.sin(t * 0.043) * 0.018 - my * 0.045;
    group.rotation.y = 0.05 + Math.sin(t * 0.031 + 1.3) * 0.02 + mx * 0.06;
    group.position.z = -dolly + mx * 0.1;
  },

  dispose() {
    if (onPointer) { window.removeEventListener('pointermove', onPointer); onPointer = null; }
    if (group && ctxRef) ctxRef.world.remove(group);
    if (geometry) geometry.dispose();
    if (material) material.dispose();
    geometry = null; material = null; points = null; group = null; uniforms = null; ctxRef = null;
  }
};
