/**
 * void.js — "the void in which we pull it from".
 *
 * One full-screen fragment shader on a PlaneGeometry(2, 2) in `ctx.backdrop`.
 * This is the atmospheric ground the entire site sits on: it is behind every
 * section, every frame, forever. So the brief is not "be interesting", it is
 * "be the deep end of a long-exposure photograph and never once ask for
 * attention".
 *
 * What is actually drawn, back to front:
 *
 *   1. the void base            near-black #040605 with a green cast
 *   2. a large vertical grade   top and bottom must not be identical
 *   3. volumetric haze          domain-warped fBm, 2–4 octaves of value noise
 *   4. two chromatic pools      a warm ember and a cool tide, gaussian, soft,
 *                               anamorphically wide, bleeding through the haze
 *   5. triangular-PDF dither    kills 8-bit banding in the darks
 *
 * ── A note on colour space ───────────────────────────────────────────────
 * The composer's grade pass writes to the canvas without an sRGB encode chunk,
 * so whatever this shader outputs is (after the ACES-ish tonemap in grade.js)
 * effectively display-referred. Passing three's *linear* PALETTE colours here
 * would land the void at ~0.4/255 — a dead, crushed black with every bit of
 * the tonality below the quantisation floor. So the palette is restated below
 * as literal sRGB floats, and the levels are tuned against grade.js's curve:
 *
 *     tonemap(0.02) ≈ 0.011  →  ~3/255      (the deepest corners)
 *     tonemap(0.03) ≈ 0.020  →  ~5/255      (the resting void — #040605)
 *     tonemap(0.05) ≈ 0.044  →  ~11/255     (a haze wisp)
 *     tonemap(0.18) ≈ 0.267  →  ~68/255     (an ember core)
 *
 * ── A note on bloom ──────────────────────────────────────────────────────
 * UnrealBloomPass is thresholded at 0.24 luminance. The hottest pixel this
 * shader can produce sits at ~0.15 luminance even at full level + beat. That
 * is deliberate: bloom belongs to the foreground scenes (the record, the
 * particle mass). The background stays *under* the threshold so it never
 * smears or flares, and the eye never goes to it.
 */
import * as THREE from 'three';

/* Frame-rate-independent easing. Local copies so this file has no coupling
   beyond three itself. */
const lerp  = (a, b, t) => a + (b - a) * t;
const damp  = (a, b, lambda, dt) => lerp(a, b, 1 - Math.exp(-lambda * dt));
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));

/* The still frame reduced-motion users get. Picked because at t = 21.5 the
   noise field has a pleasant diagonal drift across the centre and neither
   pool is clipped by an edge. */
const STILL_TIME = 21.5;

const vertexShader = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    // PlaneGeometry(2,2) spans -1..1, which is exactly the backdrop camera's
    // frustum. Skipping the matrices makes this immune to any camera change
    // and guarantees an exact full-screen fit.
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const fragmentShader = /* glsl */`
  precision highp float;

  varying vec2 vUv;

  uniform float uTime;      // seconds — frozen when reducedMotion
  uniform float uAspect;    // width / height
  uniform float uProgress;  // 0..1 down the document (drives the hue balance)
  uniform float uParallax;  // scroll in viewport-heights (drives noise drift)
  uniform float uSmear;     // 0..1 from scroll velocity — vertical stretch
  uniform float uLevel;     // 0..1 smoothed loudness
  uniform float uBass;      // 0..1 low band — swells the pool radii
  uniform float uBeat;      // 0..1 fast-decaying transient spike
  uniform float uDither;    // dither amplitude in pre-tonemap units
  uniform float uMotion;    // 1 normally, 0 under reducedMotion — gates *position*
                            // only, so the hue balance still follows the page
                            // (a slow tint is not motion) while nothing travels

  /* ── Palette, as display-referred sRGB (see the header note) ─────────── */
  const vec3 C_VOID  = vec3(0.0157, 0.0235, 0.0196);  // #040605
  const vec3 C_MOSS  = vec3(0.0627, 0.1020, 0.0824);  // #101a15
  const vec3 C_EMBER = vec3(1.0000, 0.6039, 0.3529);  // #ff9a5a
  const vec3 C_TIDE  = vec3(0.4980, 0.7059, 1.0000);  // #7fb4ff

  /* ── Hash → noise ────────────────────────────────────────────────────────
     Dave Hoskins' sine-free 3D→1D hash. sin()-based hashes band badly on
     mobile GPUs (they run at mediump internally); this one is stable and
     cheaper. */
  float hash13(vec3 p) {
    p  = fract(p * 0.1031);
    p += dot(p, p.zyx + 31.32);
    return fract((p.x + p.y) * p.z);
  }

  /* Trilinear value noise with a QUINTIC fade. The quintic curve
     6t^5 - 15t^4 + 10t^3 has zero first AND second derivative at the cell
     boundaries, so the underlying lattice is invisible — with a cubic fade
     you can see the grid in a field this dark and this smooth. */
  float vnoise(vec3 p) {
    vec3 i = floor(p);
    vec3 f = p - i;
    vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);

    float n000 = hash13(i + vec3(0.0, 0.0, 0.0));
    float n100 = hash13(i + vec3(1.0, 0.0, 0.0));
    float n010 = hash13(i + vec3(0.0, 1.0, 0.0));
    float n110 = hash13(i + vec3(1.0, 1.0, 0.0));
    float n001 = hash13(i + vec3(0.0, 0.0, 1.0));
    float n101 = hash13(i + vec3(1.0, 0.0, 1.0));
    float n011 = hash13(i + vec3(0.0, 1.0, 1.0));
    float n111 = hash13(i + vec3(1.0, 1.0, 1.0));

    return mix(mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y),
               mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y), u.z);
  }

  /* fBm. OCTAVES is a #define so the low-quality path genuinely compiles out
     the extra taps rather than multiplying them by zero.

     Two details that separate this from a stock fbm:
       · each octave is rotated by ~37° in xy, so octaves never line up into
         visible axis-aligned streaks;
       · lacunarity is 2.03, not 2.0 — an exact doubling re-aligns the value
         lattice every octave and produces faint blocky ghosts. */
  float fbm(vec3 p) {
    float amp = 0.5;
    float sum = 0.0;
    float nrm = 0.0;
    for (int i = 0; i < OCTAVES; i++) {
      sum += amp * vnoise(p);
      nrm += amp;
      p.xy = vec2(p.x * 0.80 + p.y * 0.60,
                 -p.x * 0.60 + p.y * 0.80) * 2.03;
      p.z *= 1.19;   // fine detail churns faster than the large forms
      amp *= 0.5;
    }
    return sum / nrm;
  }

  /* A pool of light: a gaussian, not a smoothstep. exp(-r²) has no support
     boundary at all, so there is no terminator ring to band — critical when
     the whole image lives in the bottom 5% of the range.
     The 'stretch' argument makes it anamorphically wide. */
  float pool(vec2 p, vec2 c, float r, vec2 stretch) {
    vec2 d = (p - c) / stretch;
    return exp(-dot(d, d) / (r * r));
  }

  /* Interleaved gradient noise — blue-noise-like spectrum for the cost of one
     fract(). Used for the dither, keyed to gl_FragCoord so the pattern is
     pixel-locked and reads as fine grain rather than as motion. */
  float ign(vec2 p) {
    return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
  }

  void main() {
    // Aspect-corrected screen space, origin at centre, y in -0.5..0.5.
    vec2 p = vUv - 0.5;
    p.x *= uAspect;

    /* ── 1. Domain warp ────────────────────────────────────────────────────
       Two low-frequency noise taps, sampled at different z slices so they are
       decorrelated, push the sample point around before the fBm runs. This is
       what turns "clouds" into "smoke": it curls the isolines instead of just
       translating them. Skipped on the low-quality path. */
    vec2 warp = vec2(0.0);
    #if OCTAVES > 2
      vec3 wp = vec3(p * 1.15, uTime * 0.021 + uParallax * 0.18);
      warp = vec2(vnoise(wp + vec3(0.0, 0.0,  11.3)),
                  vnoise(wp + vec3(5.2, 1.3,  -7.1))) - 0.5;
    #endif

    /* ── 2. The haze field ─────────────────────────────────────────────────
       z advances at 0.045/s. At the base spatial scale of 2.2 that is one
       "cell" of change every ~10 seconds — slow enough that you cannot catch
       it moving, fast enough that a still frame 30s later is a different
       photograph. Anything faster reads as a screensaver.

       uParallax is scroll measured in viewport-heights, so the field slides
       vertically as you travel the page: the atmosphere is attached to the
       document, not to the window.

       uSmear divides the y frequency, stretching features vertically while
       the page is moving fast — a cheap, honest directional blur. */
    vec3 hp = vec3(p * 2.2, uTime * 0.045);
    hp.xy += warp * 0.55;
    hp.x  += uTime * 0.008;          // a whisper of lateral drift
    hp.y  -= uParallax * 0.40;       // scroll parallax
    hp.y  /= (1.0 + uSmear * 0.85);  // velocity smear

    float haze = fbm(hp);
    // Gamma the density so most of the frame stays empty and the wisps are
    // rare. A linear fBm looks like fog everywhere; this looks like dust.
    haze = pow(haze, 1.75);

    /* ── 3. Base: void + vertical grade ───────────────────────────────────
       Bottom runs a touch warmer, top a touch cooler and greener. Measured
       through grade.js the two ends land at roughly rgb(5,7,5) and
       rgb(3,6,5) — about two 8-bit steps of separation in the warm channel.
       You will never consciously see it; a frame without it looks like a
       flat fill.

       Note p.y only spans -0.5..0.5, so these edges (-0.62, 0.70) are chosen
       to sit outside the viewport: the ramp is always mid-curve on screen and
       never saturates against the top or bottom of the frame. */
    float vgrad = smoothstep(-0.62, 0.70, p.y);
    vec3 col = C_VOID + mix(vec3(0.0140, 0.0115, 0.0090),
                            vec3(0.0060, 0.0095, 0.0085), vgrad);

    /* Haze as dark-green dust. Level lifts density; the beat adds a crumb.

       The density used to be 0.40. The trouble is that the moss is the only
       green in the frame and it sits UNDER both pools, so wherever the ember
       was strong the sum came out khaki: measured 1 : 0.82 : 0.56 in RGB, which
       is a mud, not an orange. Dropping the dust to 0.29 and putting the energy
       back into the pools below moves the ember to roughly 1 : 0.72 : 0.44 —
       still smoke-choked and filmic, but the hue survives the fog. */
    float density = 0.29 + uLevel * 0.20 + uBeat * 0.04;
    col += C_MOSS * haze * density;

    /* ── 4. The two pools ──────────────────────────────────────────────────
       Distant practicals bleeding through fog. They drift on independent
       lissajous paths with mutually irrational periods (0.037/0.029 and
       0.023/0.031) so the pair never returns to the same arrangement — no
       loop point for the eye to latch onto.

       Bass swells the radii; scroll pushes them in opposite directions for a
       parallax depth cue against the haze. */
    float rSwell = 1.0 + uBass * 0.16 + uLevel * 0.05;

    vec2 emberC = vec2(-0.40 + 0.10 * sin(uTime * 0.037),
                        0.20 + 0.07 * cos(uTime * 0.029) + uProgress * 0.16 * uMotion);
    vec2 tideC  = vec2( 0.44 + 0.09 * cos(uTime * 0.023),
                       -0.24 + 0.08 * sin(uTime * 0.031) - uProgress * 0.20 * uMotion);

    // Anamorphic ellipses; smear stretches them vertically with the page.
    vec2 stretchE = vec2(1.55, 1.00 + uSmear * 0.55);
    vec2 stretchT = vec2(1.35, 1.00 + uSmear * 0.55);

    // Offsetting the sample point by the warp breaks the perfect ellipse, so
    // the pools have ragged, fog-eaten edges rather than airbrush edges.
    vec2 pw = p + warp * 0.12;

    float fEmber = pool(pw, emberC, 0.52 * rSwell, stretchE);
    float fTide  = pool(pw, tideC,  0.46 * rSwell, stretchT);

    // The fog modulates the light, not the other way round: where the dust is
    // thin the pool barely registers, where it is thick the light has
    // something to catch on.
    float veil = 0.40 + 0.95 * haze;
    fEmber *= veil;
    fTide  *= veil;

    /* A single anamorphic streak on the ember only — the horizontal bleed a
       spherical-front lens gives a hot point. Exponential falloff in y (thin),
       gaussian in x (soft ends), and the x term is tight enough that the
       streak has clearly died before it reaches either edge of a 16:9 frame —
       a bar that runs the full width stops reading as a lens and starts
       reading as a scanline. Kept at 8% so it is a flare, never a "laser". */
    vec2 sd = pw - emberC;
    float streak = exp(-abs(sd.y) / 0.055) * exp(-sd.x * sd.x / 0.45);
    fEmber += streak * 0.08 * veil;

    /* ── 5. Hue balance ───────────────────────────────────────────────────
       Ember-dominant at the top of the page, tide-dominant at the bottom.

       "Never a 50/50 split" cannot be enforced by making the weights
       non-crossing — a handover of dominance *is* a crossing. It is enforced
       two other ways instead:

         · the crossover is double-eased and confined to the middle of the
           document, so the equal-energy point is a knife edge you scroll
           through rather than a plateau you sit in. Integrating delivered
           luminance over the page: ember leads 6.3x at the top, tide leads
           1.9x at the bottom, the handover sits at progress ≈ 0.56, and only
           ~3% of the document is anywhere within 10% of balanced;
         · the pools are never each other's mirror. The ember is larger
           (r 0.52 vs 0.46), wider (1.55 vs 1.35), hotter (0.130 vs 0.115 on a
           brighter hue) and it is the only one carrying the anamorphic
           streak. Even at the instant the two deliver equal luminance the
           frame reads as one broad dominant light with a small cool
           counterweight — which is the thing the rule is actually protecting.

       The breath terms are two slow, mutually irrational sines: they stop the
       balance ever sitting perfectly still, and they drift the exact handover
       point by a few percent of the page over the course of minutes. */
    float mixP = smoothstep(0.24, 0.76, uProgress);
    mixP = mixP * mixP * (3.0 - 2.0 * mixP);

    float breathE = 0.86 + 0.14 * sin(uTime * 0.041 + 1.7);
    float breathT = 0.86 + 0.14 * sin(uTime * 0.033 - 0.4);

    /* The tide end used to top out at 0.92 against the ember's 1.00, and since
       the ember is also the larger, wider, hotter pool the bottom of the page
       came out measurably darker than the top — the last screen a visitor sees
       was the dimmest frame on the site. 1.12 evens out the delivered
       luminance without touching the dominance: at the foot of the page tide
       still outweighs ember about 3.7:1 by weight, so the handover stays a
       handover and never a 50/50 truce. */
    float wEmber = mix(1.00, 0.30, mixP) * breathE;
    float wTide  = mix(0.26, 1.12, mixP) * breathT;

    // Beat: a small, fast lift on the light only — the void itself never
    // flashes. ~5% at a full transient.
    float lift = 1.0 + uBeat * 0.18 + uLevel * 0.10;

    col += C_EMBER * fEmber * wEmber * 0.150 * lift;
    col += C_TIDE  * fTide  * wTide  * 0.132 * lift;

    /* ── 6. Dither ────────────────────────────────────────────────────────
       Two decorrelated IGN samples summed give a TRIANGULAR PDF, which
       decouples the dither noise from the signal level (a single uniform
       sample leaves visible noise modulation on the ramps).

       Amplitude is specified pre-tonemap, so it has to be pre-compensated for
       the grade curve. Counter-intuitively the ACES-ish tonemap in grade.js
       *expands* this part of the range rather than compressing it — its slope
       around x = 0.035 is ≈ 1.2, not the ≈ 0.5 you would guess from the fact
       that it darkens the value. So 0.0016 in lands at ≈ ±0.5/255 out: one
       quantisation step peak-to-peak, which is exactly enough to dissolve the
       contours and not one bit more. (grade.js then lays its own film grain
       on top; this exists so the gradients are already clean underneath it.) */
    float d1 = ign(gl_FragCoord.xy);
    float d2 = ign(gl_FragCoord.xy + 17.31);
    col += (d1 + d2 - 1.0) * uDither;

    gl_FragColor = vec4(max(col, 0.0), 1.0);
  }
`;

/* ── Module state ────────────────────────────────────────────────────────── */
let mesh = null;
let geometry = null;
let material = null;
let uniforms = null;
let parent = null;

let clock = 0;        // our own time accumulator, so reducedMotion can freeze it
let octaves = 0;      // currently compiled octave count

/* Damped mirrors of ctx.state — the shader never sees a raw value, so nothing
   can pop on a single bad frame. */
let vLevel = 0, vBass = 0, vBeat = 0, vProgress = 0, vParallax = 0, vSmear = 0;
let vMotion = 1;

export default {
  id: 'global',
  alwaysUpdate: true,   // it is behind everything, so it is never off-screen

  init(ctx) {
    const { w, h } = ctx.sizes;

    geometry = new THREE.PlaneGeometry(2, 2);

    uniforms = {
      uTime:     { value: STILL_TIME },
      uAspect:   { value: h > 0 ? w / h : 1 },
      uProgress: { value: 0 },
      uParallax: { value: 0 },
      uSmear:    { value: 0 },
      uLevel:    { value: 0 },
      uBass:     { value: 0 },
      uBeat:     { value: 0 },
      uDither:   { value: 0.0016 },
      uMotion:   { value: 1 }
    };

    octaves = ctx.state.quality >= 1 ? 4 : 2;

    material = new THREE.ShaderMaterial({
      uniforms,
      vertexShader,
      fragmentShader,
      defines: { OCTAVES: octaves },
      depthTest: false,
      depthWrite: false,
      transparent: false,
      fog: false
    });

    mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;     // we bypass the matrices in the VS
    mesh.matrixAutoUpdate = false;
    mesh.renderOrder = -1000;       // first thing drawn in the backdrop scene
    mesh.name = 'void';

    parent = ctx.backdrop;
    parent.add(mesh);

    // Start mid-drift rather than at t=0, where a value-noise field is at its
    // most regular-looking.
    clock = STILL_TIME;

    // Module-level state survives a dispose/init cycle, so reset the damped
    // mirrors explicitly rather than inheriting the last session's values.
    vLevel = vBass = vBeat = vProgress = vParallax = vSmear = 0;
    vMotion = ctx.state.reducedMotion ? 0 : 1;
  },

  update(ctx, dt) {
    if (!uniforms) return;
    const s = ctx.state;

    /* Recompile only when the perf governor actually steps quality. Dropping
       to 2 octaves also compiles out the domain warp (#if OCTAVES > 2), which
       is 2 of the 6 noise evaluations. */
    const wantOct = s.quality >= 1 ? 4 : 2;
    if (wantOct !== octaves) {
      octaves = wantOct;
      material.defines.OCTAVES = octaves;
      material.needsUpdate = true;
    }

    /* reducedMotion: hold one composed still. Time stops, parallax stops, and
       the audio terms ease to zero — a background that pulses is exactly what
       the preference is asking us not to do. */
    if (s.reducedMotion) {
      uniforms.uTime.value = STILL_TIME;
      vMotion   = damp(vMotion, 0, 3, dt);
      uniforms.uMotion.value = vMotion;
      vLevel    = damp(vLevel, 0, 3, dt);
      vBass     = damp(vBass, 0, 3, dt);
      vBeat     = damp(vBeat, 0, 3, dt);
      vSmear    = damp(vSmear, 0, 3, dt);
      vParallax = damp(vParallax, 0, 3, dt);
      vProgress = damp(vProgress, s.progress || 0, 1.2, dt); // hue only, no motion
      uniforms.uLevel.value    = vLevel;
      uniforms.uBass.value     = vBass;
      uniforms.uBeat.value     = vBeat;
      uniforms.uSmear.value    = vSmear;
      uniforms.uParallax.value = vParallax;
      uniforms.uProgress.value = vProgress;
      return;
    }

    clock += dt;
    uniforms.uTime.value = clock;

    // Eased so that toggling the OS preference mid-session settles rather
    // than snapping the pools back into place.
    vMotion = damp(vMotion, 1, 3, dt);
    uniforms.uMotion.value = vMotion;

    /* Audio, all damped. λ is in "e-folds per second", so these are stable at
       any frame rate: λ=3 settles in ~1s, λ=34 in ~90ms. */
    vLevel = damp(vLevel, clamp(s.level || 0), 3.0, dt);
    vBass  = damp(vBass,  clamp(s.bass  || 0), 4.5, dt);

    // The beat needs an asymmetric envelope: snap up on the transient, fall
    // off slowly enough to read as a swell rather than a strobe.
    const beat = clamp(s.beat || 0);
    vBeat = damp(vBeat, beat, beat > vBeat ? 34 : 6, dt);

    uniforms.uLevel.value = vLevel;
    uniforms.uBass.value  = vBass;
    uniforms.uBeat.value  = vBeat;

    /* Scroll. `progress` drives the ember→tide balance and is damped hard so
       a flung scrollbar does not swing the colour. `parallax` is scroll in
       viewport-heights, which keeps the drift rate identical on a phone and
       on a 6K display. */
    vProgress = damp(vProgress, clamp(s.progress || 0), 2.2, dt);
    uniforms.uProgress.value = vProgress;

    const vh = Math.max(ctx.sizes.h, 1);
    vParallax = damp(vParallax, (s.scroll || 0) / vh, 5.0, dt);
    uniforms.uParallax.value = vParallax;

    /* Velocity → vertical smear. state.velocity is px/frame; ~55px/frame is a
       hard flick, and the effect caps at a 35% stretch so it stays a texture
       cue and never a whip-pan. */
    const vel = clamp(Math.abs(s.velocity || 0) / 55);
    vSmear = damp(vSmear, vel * 0.35, 6.0, dt);
    uniforms.uSmear.value = vSmear;
  },

  resize(w, h) {
    if (uniforms) uniforms.uAspect.value = h > 0 ? w / h : 1;
  },

  dispose() {
    if (mesh && parent) parent.remove(mesh);
    geometry?.dispose();
    material?.dispose();
    mesh = null;
    geometry = null;
    material = null;
    uniforms = null;
    parent = null;
  }
};
