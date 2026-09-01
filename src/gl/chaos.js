/**
 * chaos.js — "Chaos / Control", the thesis of the brand rendered in 3D.
 *
 * ONE THREE.Points object, ~123k particles, one draw call. Every particle
 * carries two identities at once:
 *
 *   • an ORDERED target  (baked into `position`) — its seat in a 3D waveform /
 *     waterfall-spectrogram ribbon: 1024 samples across × 120 time-slices deep,
 *     clean parallel ridges, symmetric about the centre line.
 *   • a CHAOTIC origin   (attribute `aChaos`) — a random point in a gaussian
 *     blob that the vertex shader then advects through a curl-noise field, so
 *     it lands somewhere inside a tangle of incompressible filaments.
 *
 * `sections.get('chaos').progress` drives a single master morph uniform. The
 * whole transformation — position, colour, size, brightness — happens on the
 * GPU in the vertex shader, per particle, with a staggered delay so order
 * *propagates* out from the centre of the ribbon instead of snapping in unison.
 *
 * Composition: the ribbon lives in a raked, off-centre group (turned away from
 * the camera so its left end recedes into fog and its right end is cropped by
 * the frame). A screen-space guard fades anything drifting into the left
 * columns, where the body copy lives.
 */
import * as THREE from 'three';
import { clamp, lerp, damp } from '../core/bus.js';

/* ────────────────────────────────────────────────────────────────────────────
   Shaders
   ──────────────────────────────────────────────────────────────────────── */

const VERT = /* glsl */`
precision highp float;

/* position (built-in) = the ORDERED target: the particle's seat on the ribbon */
attribute vec3 aChaos;   /* the particle's chaotic origin, pre-advection      */
attribute vec4 aMeta;    /* x seed 0..1 | y size variance | z morph delay 0..1
                            w ridge height -1..1 (for the ember rim accent)   */

uniform float uTime;      /* frozen at 0 when reducedMotion                    */
uniform float uMotion;    /* 1 normally, 0 when reducedMotion                  */
uniform float uMorph;     /* MASTER: 0 = chaos, 1 = control                    */
uniform float uOpacity;   /* section edge fade                                 */
uniform float uTurb;      /* curl advection amplitude (audio: level)           */
uniform float uStretch;   /* streamline smear → filaments                      */
uniform float uShock;     /* audio: decaying beat impulse                      */
uniform float uHeight;    /* ordered ridge height gain (audio: level)          */
uniform float uArc;       /* how far particles bow off the straight line       */
uniform float uSize;      /* particle diameter in world units                  */
uniform float uPointScale;/* px per world unit at 1 unit distance              */
uniform float uDensity;   /* brightness compensation when the count is halved  */
uniform vec2  uGuard;     /* NDC.x band over which the left-column guard ramps */
uniform float uGuardMin;  /* floor of the guard (never fully black)            */

uniform vec3 uEmber, uEmber2, uTide, uTide2, uBone, uMoss;

varying vec3  vCol;
varying float vAlpha;
varying float vCore;

/* ── Value noise with ANALYTIC derivatives ───────────────────────────────────
   Trilinear value noise over an integer lattice, faded with the quintic
   u(t) = 6t^5 − 15t^4 + 10t^3.  Both the fade and the trilinear blend are
   polynomials, so the gradient is exact — closed form, no finite differencing.

   Returns vec4( value, ∂v/∂x, ∂v/∂y, ∂v/∂z ), value remapped to −1..1.       */
float hash1(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

vec4 noised(vec3 x) {
  vec3 p = floor(x);
  vec3 w = fract(x);
  vec3 u  = w * w * w * (w * (w * 6.0 - 15.0) + 10.0);   /* quintic fade      */
  vec3 du = 30.0 * w * w * (w * (w - 2.0) + 1.0);        /* its derivative    */

  float a = hash1(p + vec3(0.0, 0.0, 0.0));
  float b = hash1(p + vec3(1.0, 0.0, 0.0));
  float c = hash1(p + vec3(0.0, 1.0, 0.0));
  float d = hash1(p + vec3(1.0, 1.0, 0.0));
  float e = hash1(p + vec3(0.0, 0.0, 1.0));
  float f = hash1(p + vec3(1.0, 0.0, 1.0));
  float g = hash1(p + vec3(0.0, 1.0, 1.0));
  float h = hash1(p + vec3(1.0, 1.0, 1.0));

  /* trilinear blend rewritten as a polynomial in u so the partials fall out  */
  float k0 =  a;
  float k1 =  b - a;
  float k2 =  c - a;
  float k3 =  e - a;
  float k4 =  a - b - c + d;
  float k5 =  a - c - e + g;
  float k6 =  a - b - e + f;
  float k7 = -a + b + c - d + e - f - g + h;

  float v = k0 + k1 * u.x + k2 * u.y + k3 * u.z
          + k4 * u.x * u.y + k5 * u.y * u.z + k6 * u.z * u.x
          + k7 * u.x * u.y * u.z;

  /* chain rule: ∂v/∂x = (∂v/∂u.x) · du.x, etc. */
  vec3 dv = du * vec3(
    k1 + k4 * u.y + k6 * u.z + k7 * u.y * u.z,
    k2 + k4 * u.x + k5 * u.z + k7 * u.z * u.x,
    k3 + k5 * u.y + k6 * u.x + k7 * u.x * u.y
  );

  return vec4(-1.0 + 2.0 * v, 2.0 * dv);
}

/* ── Curl of a vector potential ──────────────────────────────────────────────
   Build Ψ(p) = (ψ1, ψ2, ψ3) from three decorrelated samples of the same noise
   lattice (large irrational offsets keep them independent), then take

     v = ∇ × Ψ = ( ∂ψ3/∂y − ∂ψ2/∂z ,
                   ∂ψ1/∂z − ∂ψ3/∂x ,
                   ∂ψ2/∂x − ∂ψ1/∂y )

   Every partial is read straight out of noised()'s analytic gradient, so
   ∇·v ≡ 0 exactly. That incompressibility is the whole point: an advected
   cloud can never pile up or punch holes, it can only be sheared and folded —
   which is what produces ropey, braided, genuinely turbulent filaments rather
   than noise-jittered confetti.

   noised() packs the gradient in .yzw = (d/dx, d/dy, d/dz).                   */
vec3 curl(vec3 p) {
  vec4 n1 = noised(p);
  vec4 n2 = noised(p + vec3( 31.416,  47.853,  19.271));
  vec4 n3 = noised(p + vec3(-17.329,  83.147, -61.502));
  return vec3(n3.z - n2.w,    /* ∂ψ3/∂y − ∂ψ2/∂z */
              n1.w - n3.y,    /* ∂ψ1/∂z − ∂ψ3/∂x */
              n2.y - n1.z);   /* ∂ψ2/∂x − ∂ψ1/∂y */
}

/* Two octaves: the second adds fine braiding inside the big ropes.
   curl(f·p) is (1/f)× the true p-space curl of the potential Ψ(f·p), i.e. it is
   still exactly the curl of *some* potential — so the octaves stay individually
   divergence-free and so does their sum. */
vec3 curlFbm(vec3 p) {
  vec3 v = curl(p);
#ifdef HI_QUALITY
  v += curl(p * 2.17 + 11.3) * 0.5;
#endif
  return v;
}

/* ── CHAOS: advect the origin through the field ───────────────────────────── */
vec3 chaosPos(vec3 base, float seed) {
  /* the field itself drifts, slowly — off entirely under reducedMotion */
  float dr = uTime * 0.055 * uMotion;

  vec3 q = base;

  /* Euler step 1 — the large-scale tangle.
     The frequency here has to be read against the SIZE OF THE CLOUD, not
     chosen for its own sake: at 0.115 the noise lattice cell was 8.7 world
     units and the whole blob fitted inside one of them, so the "curl field"
     did little more than translate the cloud bodily and the result was an even
     fog of dots. At 0.27 the cloud spans ~3 cells in each axis and the
     displacement is about half a cell, which is the regime where a curl field
     actually folds and braids. */
  vec3 v1 = curlFbm(q * 0.27 + vec3(dr, dr * 0.7, -dr * 1.3));
  q += v1 * uTurb;

  /* Euler step 2 — a finer pass. Two integration steps through a curl field is
     what folds a cloud of dots into stretched, braided sheets. */
  vec3 v2 = curl(q * 0.74 + vec3(-dr * 1.9, dr * 1.4, dr));
  q += v2 * uTurb * 0.42;

  /* Smear each particle ALONG its local streamline by its own seed. Neighbours
     share a flow direction, so a blob of dots becomes a bundle of ropes.
     The beat rides the same axis — a shock pulse travelling with the flow. */
  vec3 dir = normalize(v1 + vec3(1e-4));
  q += dir * ((seed - 0.5) * uStretch + uShock * 1.15);

  return q;
}

void main() {
  float seed  = aMeta.x;
  float delay = aMeta.z;

  /* ── The morph maths ──────────────────────────────────────────────────────
     Each particle owns a private window of the master timeline. BAND is how
     long one particle takes to resolve; its delay is scaled into the leftover
     head-room so that EVERY particle is still fully chaotic at uMorph = 0 and
     fully resolved at uMorph = 1, no matter how late it starts.

     delay itself was baked on the CPU as
         0.76 · (normalised distance of the target from the ribbon centre)
       + 0.24 · random
     so order propagates outward from the middle of the ribbon toward both
     ends, with enough per-particle jitter that the front has a ragged,
     organic edge instead of a hard line. BAND is deliberately narrow: the
     shorter each particle's own flight, the crisper the wavefront reads.     */
  const float BAND = 0.27;
  float t0 = delay * (1.0 - BAND);
  float w  = smoothstep(t0, t0 + BAND, uMorph);
  w = w * w * (3.0 - 2.0 * w);          /* smootherstep: softer arrival       */

  /* ORDERED target — the ribbon, with audio pushing the ridge height */
  vec3 po = position;
  po.y *= uHeight;
  /* a whisper of travelling swell so "resolved" never means "dead" */
  po.y += sin(po.x * 0.55 - uTime * 0.75) * 0.05 * uMotion;

  /* CHAOTIC position — skipped entirely once a particle has resolved (this
     branch is spatially coherent, so warps stay together) */
  vec3 pc = aChaos;
  if (w < 0.998) pc = chaosPos(aChaos, seed);

  /* Mid-morph must not read as a lerp. arc peaks at exactly w = 0.5, and
     bows the particle sideways off the straight line (about the axis
     perpendicular to its travel), so it sweeps into place on a curve. */
  float arc = w * (1.0 - w) * 4.0;
  vec3 delta = po - pc;
  vec3 axis  = normalize(cross(delta, vec3(0.0, 1.0, 0.0)) + vec3(1e-5));

  vec3 pos = mix(pc, po, w);
  pos += axis * arc * uArc * (0.35 + seed * 0.9);
  pos.y += arc * uArc * 0.32;

  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  float dist = max(-mv.z, 0.05);
  vec4 clip = projectionMatrix * mv;

  /* ── Colour ───────────────────────────────────────────────────────────────
     Colour trails the position slightly (0.15..0.95 instead of 0..1) so the
     resolution front is a visible colour boundary, not just a shape change. */
  float wc = smoothstep(0.15, 0.95, w);
  float j  = fract(seed * 97.13);

  /* CHAOS — scattered ember. Deliberately not a clean gradient: the hue jumps
     between the two embers and a quarter of the specks fall dead, which is what
     makes the mass read as agitated and a bit ugly.
     The dead specks used to be uMoss × 2.2 — a saturated dark GREEN. Additively
     stacked and bloomed that produced bright green confetti in a palette that
     owns no green accent at all. They are now a near-neutral warm ash: still
     dead, still breaking the hue, but they no longer introduce a third hue. */
  vec3 cChaos = mix(uEmber2, uEmber, j);
  vec3 ash = uMoss * 1.55 + uEmber2 * 0.085;      /* ≈ #26332b + a warm bias */
  cChaos = mix(cChaos, ash, step(0.74, j) * 0.58);
  cChaos *= 0.5 + j * 1.0;

  /* CONTROL — cool tide, with ember ONLY as a rim accent riding the crests.
     The ember mix has to stay small and stay at the very TOP of the crest.
     Since the energy is now weighted onto the crests, a 40% ember mix across
     the whole upper half of the profile desaturated exactly the pixels that
     carry the image — the ribbon came out neutral grey. 18%, gated to the last
     quarter of the ridge, keeps the object unmistakably tide-blue with a warm
     line along its edge, which is the tension the brief asks for. */
  float crest = smoothstep(0.30, 1.0, aMeta.w);
  float lip   = smoothstep(0.74, 1.0, aMeta.w);
  vec3 cOrder = mix(uTide, uTide2, 0.10 + 0.34 * crest);
  cOrder = mix(cOrder, uEmber, lip * 0.18);
  /* Weight the energy hard onto the crests. A flat brightness across the ridge
     profile gives an even blue haze; putting most of it on the crest lines is
     what makes the resolved object read as LIT parallel ridges — a surface
     catching a light — rather than as a field of blue dots. */
  cOrder *= 0.60 + crest * 1.08;

  vec3 col = mix(cChaos, cOrder, wc);
  /* the white-hot wavefront where order is actually winning */
  col = mix(col, uBone * 1.15, arc * 0.45);

  /* ── Brightness (authored in display-referred sRGB) ───────────────────────
     Chaos is a sparse volume, control is a dense surface — the surface needs
     far less per-particle energy or the additive stack blows out.
     Single particles sit under the 0.24 bloom threshold; overlaps in the dense
     core, on the ridge crests and in the wavefront cross it and flare.

     The ordered end used to sit at 0.078 — 2.6x below chaos — on the theory
     that a dense surface needs less energy than a sparse volume. In practice
     the resolved ribbon is *thinner* on screen than the chaos cloud is, not
     denser, and it measured at nothing: the whole section peaked at 46/255
     against 173 for the hero and 222 for the record. It now lands in the same
     bracket as its neighbours. */
  float inten = mix(0.260, 0.205, w) * uDensity;
  inten *= 1.0 + arc * 1.25 + uShock * 0.5;

  /* depth: our own exponential-squared fade to the void (correct for additive,
     where "fog" just means "add less"), plus a near cull so nothing near the
     camera turns into a dinner plate */
  float fade = exp(-pow(max(dist - 5.0, 0.0) * 0.052, 2.0));
  fade *= smoothstep(1.0, 3.6, dist);

  /* left-column guard: the body copy lives in grid columns 1–6, so fade hard
     in screen space rather than trusting world coordinates through the rake */
  float ndcX = clip.x / max(clip.w, 1e-3);
  float guard = mix(uGuardMin, 1.0, smoothstep(uGuard.x, uGuard.y, ndcX));

  vCol   = col;
  vAlpha = inten * fade * guard * uOpacity;
  vCore  = arc * 0.9;

  if (vAlpha < 0.0025) {          /* cheap cull for fully faded particles */
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    return;
  }

  gl_Position = clip;

  /* size attenuation: a sphere of diameter uSize at distance d subtends
     uSize · uPointScale / dist pixels. Chaos motes are larger and softer,
     resolved ones tighter and sharper. */
  /* Resolved grains are a touch LARGER than chaotic ones, not smaller. The
     ordered ribbon is a thin sheet seen almost edge-on: at 1px per grain it
     rendered as scratches. At ~1.5px they overlap along each crest and the
     ridge becomes a continuous line of light. */
  float sz = uSize * aMeta.y * mix(1.95, 1.55, w) * (1.0 + arc * 0.35);
  gl_PointSize = clamp(sz * uPointScale / dist, 0.7, 26.0);
}
`;

const FRAG = /* glsl */`
precision highp float;

varying vec3  vCol;
varying float vAlpha;
varying float vCore;

void main() {
  /* soft round sprite with a bright pinpoint core */
  vec2 d = gl_PointCoord - 0.5;
  float r2 = dot(d, d);
  if (r2 > 0.25) discard;

  float r = sqrt(r2) * 2.0;             /* 0 at centre → 1 at the rim */
  float halo = 1.0 - r;
  halo *= halo * halo;                  /* cubic falloff: a wide, gentle glow */
  float core = smoothstep(0.40, 0.0, r);
  core *= core;

  float a = halo * 0.55 + core * (0.85 + vCore);

  gl_FragColor = vec4(vCol, a * vAlpha);
}
`;

/* ────────────────────────────────────────────────────────────────────────────
   Scene module
   ──────────────────────────────────────────────────────────────────────── */

/* Ribbon dimensions, in world units.
   These are solved against the camera (fov 42, z = 12) and the control-state
   framing below so that the WHOLE ordered object lands inside the frustum with
   only its right end cropped. The previous 26×9 ribbon put ~80% of itself
   either off the right edge or inside the left-column guard, which is why the
   payoff of the section — "it resolves" — resolved into an empty screen. */
const RIB_W = 17.5;   /* along x — the time axis of the waveform       */
const RIB_D = 6.5;    /* along z — stacked time-slices (the waterfall) */
const RIB_H = 1.6;    /* peak ridge height                             */

const smootherstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0));
  return t * t * t * (t * (t * 6 - 15) + 10);
};

export default {
  id: 'chaos',
  alwaysUpdate: true,          /* so we can hide ourselves when off-screen */

  _ctx: null,
  _group: null,
  _points: null,
  _geo: null,
  _mat: null,
  _u: null,
  _shock: 0,
  _portrait: false,
  _hi: false,

  init(ctx) {
    this._ctx = ctx;
    const { THREE: T = THREE, state } = ctx;
    const hi = Math.min(ctx.quality ?? 1, state.quality ?? 1) >= 1 && !state.coarse;
    this._hi = hi;

    /* ── Grid: GX samples across × GY stacked slices ────────────────────── */
    const GX = hi ? 1024 : 704;
    const GY = hi ? 120 : 84;
    const N = GX * GY;                       /* 122,880 hi / 59,136 low */

    const pos = new Float32Array(N * 3);
    const chaos = new Float32Array(N * 3);
    const meta = new Float32Array(N * 4);

    /* Per-column constants, hoisted out of the inner loop.
       s ∈ −1..1 across the ribbon; a = |s| makes the ridge train symmetric
       about the centre line, so the resolved object is mirror-symmetric.
       env tapers the amplitude toward both ends like a note decaying. */
    const sCol = new Float32Array(GX);
    const aCol = new Float32Array(GX);
    const envCol = new Float32Array(GX);
    for (let i = 0; i < GX; i++) {
      const u = i / (GX - 1);
      const s = (u - 0.5) * 2;
      const a = Math.abs(s);
      sCol[i] = s;
      aCol[i] = a;
      envCol[i] = Math.pow(Math.cos(s * Math.PI * 0.5), 1.5);
    }

    const halfW = RIB_W * 0.5;
    const halfD = RIB_D * 0.5;

    let n = 0;
    for (let jy = 0; jy < GY; jy++) {
      const v = jy / (GY - 1);              /* 0 = newest slice, at the front */
      const z = (v - 0.5) * RIB_D;
      /* older slices sit further back, flatter and slightly raised — the
         classic waterfall-spectrogram read */
      const amp = (1 - v) * 0.58 + 0.42;
      const rise = v * 0.55;
      /* a gentle shear across depth so the ridges are parallel but not a
         lifeless extrusion */
      const ph = (v - 0.5) * 0.62;
      const ph2 = -ph * 1.6;

      for (let ix = 0; ix < GX; ix++, n++) {
        const a = aCol[ix];
        const ridge = Math.cos(a * Math.PI * 7.0 + ph) * 0.8
                    + Math.cos(a * Math.PI * 17.0 + ph2) * 0.26;
        const shaped = ridge * envCol[ix];   /* ≈ −1..1 */

        const x = sCol[ix] * halfW;
        const y = shaped * amp * RIB_H + rise;

        const i3 = n * 3;
        pos[i3] = x;
        pos[i3 + 1] = y;
        pos[i3 + 2] = z;

        /* ── chaotic origin: a gaussian blob, biased right of frame centre.
           Three uniforms summed ≈ a bell curve, so the cloud has a dense core
           and thin outskirts rather than a flat-topped box.

           The blob used to be ±7.4 world units wide. Spread over that volume,
           then advected and streamline-smeared, 123k grains covered most of the
           frustum at roughly one grain per 40 screen pixels — the "chaotic
           mass" read as sensor dust, not as a mass. Tightening the cloud to
           ±5.2 concentrates the same particle budget into something with a
           core and an outline, which is what makes it read as a tangle you
           could grab, and it makes the resolution sweep legible because there
           is now a visible object being swept. */
        const gx = (Math.random() + Math.random() + Math.random() - 1.5) / 1.5;
        const gy = (Math.random() + Math.random() + Math.random() - 1.5) / 1.5;
        const gz = (Math.random() + Math.random() + Math.random() - 1.5) / 1.5;
        chaos[i3] = 1.2 + gx * 5.2;
        chaos[i3 + 1] = 0.5 + gy * 2.9;
        chaos[i3 + 2] = 0.8 + gz * 3.4;

        /* ── morph delay: distance of the TARGET from the ribbon centre,
           normalised, plus jitter. Drives the outward sweep. */
        const rx = x / halfW;
        const rz = z / halfD;
        const rad = Math.min(1, Math.sqrt(rx * rx * 0.94 + rz * rz * 0.28));
        /* the delay jitter gets its own draw so hue/size never correlate with
           the sweep — the front should look ragged, not colour-sorted */
        const jit = Math.random();

        const i4 = n * 4;
        meta[i4] = Math.random();                         /* seed             */
        meta[i4 + 1] = 0.55 + Math.random() * 1.35;       /* size variance    */
        meta[i4 + 2] = clamp(rad * 0.76 + jit * 0.24);    /* delay            */
        meta[i4 + 3] = shaped;                            /* crest, for the rim */
      }
    }

    const geo = new T.BufferGeometry();
    geo.setAttribute('position', new T.BufferAttribute(pos, 3));
    geo.setAttribute('aChaos', new T.BufferAttribute(chaos, 3));
    geo.setAttribute('aMeta', new T.BufferAttribute(meta, 4));
    /* the chaotic state reaches far outside the ordered bounds — never let
       three cull us on the ribbon's bounding sphere */
    geo.boundingSphere = new T.Sphere(new T.Vector3(0, 0, 0), 40);

    /* ── Colour space ────────────────────────────────────────────────────────
       The composer's final ShaderPass writes straight to the canvas with no
       linear→sRGB encode (there is no OutputPass in stage.js). Feeding it
       three's colour-managed *linear* palette would crush every mid-tone, so
       the brand colours are restated here as literal DISPLAY-REFERRED sRGB
       floats and every level below is authored against those.

       UnrealBloomPass threshold is 0.24 luminance: the bulk of the field is
       tuned to sit under it and stay filmic, while ember specks, ridge crests
       and the resolution wavefront are tuned to cross it and flare. */
    const srgb = (r, g, b) => new T.Vector3(r, g, b);
    const C = {
      ember:  srgb(1.000, 0.604, 0.353),   /* #ff9a5a */
      ember2: srgb(0.949, 0.455, 0.227),   /* #f2743a */
      tide:   srgb(0.498, 0.706, 1.000),   /* #7fb4ff */
      tide2:  srgb(0.663, 0.839, 0.933),   /* #a9d6ee */
      bone:   srgb(0.957, 0.929, 0.886),   /* #f4ede2 */
      moss:   srgb(0.063, 0.102, 0.082)    /* #101a15 */
    };

    const u = {
      uTime:       { value: 0 },
      uMotion:     { value: state.reducedMotion ? 0 : 1 },
      uMorph:      { value: 0 },
      uOpacity:    { value: 0 },
      uTurb:       { value: 1.72 },
      uStretch:    { value: 1.95 },
      uShock:      { value: 0 },
      uHeight:     { value: 1 },
      uArc:        { value: 1.6 },
      uSize:       { value: 0.0132 },
      uPointScale: { value: 1200 },
      uDensity:    { value: hi ? 1.0 : 1.45 },
      uGuard:      { value: new T.Vector2(-0.55, 0.35) },
      uGuardMin:   { value: 0.05 },
      uEmber:      { value: C.ember },
      uEmber2:     { value: C.ember2 },
      uTide:       { value: C.tide },
      uTide2:      { value: C.tide2 },
      uBone:       { value: C.bone },
      uMoss:       { value: C.moss }
    };
    this._u = u;

    const mat = new T.ShaderMaterial({
      uniforms: u,
      vertexShader: VERT,
      fragmentShader: FRAG,
      defines: hi ? { HI_QUALITY: 1 } : {},
      blending: T.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
      transparent: true
    });

    const points = new T.Points(geo, mat);
    points.frustumCulled = false;
    points.renderOrder = 4;

    const group = new T.Group();
    group.add(points);
    group.visible = false;
    ctx.world.add(group);

    this._geo = geo;
    this._mat = mat;
    this._points = points;
    this._group = group;

    this.resize(ctx.sizes.w, ctx.sizes.h);
  },

  /**
   * Composition + point-size scale. Both depend on the viewport, so they live
   * here rather than in the frame loop.
   */
  resize(w, h) {
    const ctx = this._ctx;
    if (!ctx || !this._u) return;

    const dpr = ctx.sizes.dpr || 1;
    const fov = (ctx.cameraW.fov * Math.PI) / 180;
    /* pixels subtended by one world unit at one unit of distance */
    this._u.uPointScale.value = (h * dpr) / (2 * Math.tan(fov * 0.5));

    /* Portrait: the copy goes full-width, so there is no left column to
       protect — instead sit the whole thing further back and lower, and
       relax the guard into a soft, even dim. */
    const portrait = w / h < 1.0;
    this._portrait = portrait;
    if (portrait) {
      this._u.uGuard.value.set(-1.3, 0.7);
      this._u.uGuardMin.value = 0.34;
      this._group.scale.setScalar(0.9);
    } else {
      this._u.uGuard.value.set(-0.55, 0.35);
      this._u.uGuardMin.value = 0.05;
      this._group.scale.setScalar(w / h < 1.5 ? 0.94 : 1.0);
    }
  },

  update(ctx, dt, t, rec) {
    const g = this._group;
    if (!g) return;

    /* off-screen: hide and spend nothing */
    if (rec && !rec.visible) { g.visible = false; return; }
    g.visible = true;

    const u = this._u;
    const st = ctx.state;

    /* The perf governor can step quality down after we've already allocated the
       buffer. We can't shrink the count, but we can drop the second curl octave
       — by far the most expensive thing in the vertex shader. One recompile. */
    if (this._hi && Math.min(ctx.quality ?? 1, st.quality ?? 1) < 1) {
      this._hi = false;
      delete this._mat.defines.HI_QUALITY;
      this._mat.needsUpdate = true;
    }

    const motion = st.reducedMotion ? 0 : 1;
    const p = rec ? rec.progress : 0;

    u.uMotion.value = motion;
    u.uTime.value = motion ? t : 0;

    /* ── Master morph ────────────────────────────────────────────────────────
       The section is several viewports tall; it is only genuinely on screen
       from p ≈ 0.2 to p ≈ 0.8, so the morph is remapped into that window.
       Chaos holds while the reader is on "riff salad", control has landed by
       the time they reach the closing quote. Damped, so fast scrolling drags
       the transformation slightly behind the page — it feels like mass.

       Landing the morph at p = 0.82 meant the resolved state existed for about
       a fifth of a viewport before the section faded — the payoff arrived and
       left in the same scroll gesture. It now completes at 0.68 and then HOLDS,
       so the reader gets a beat of stillness on the resolved object before it
       goes. Chaos still holds through the "riff salad" copy. */
    const target = smootherstep(0.18, 0.68, p);
    u.uMorph.value = motion
      ? damp(u.uMorph.value, target, 9, dt)
      : target;

    /* edge fades so we never collide with the neighbouring scenes */
    u.uOpacity.value = smootherstep(0.02, 0.15, p) * (1 - smootherstep(0.84, 0.98, p));

    /* ── Audio: seasoning only, and silent under reducedMotion ───────────── */
    const level = motion ? st.level : 0;
    const beat = motion ? st.beat : 0;

    /* beat → a decaying shock that rides the flow / kicks the ridges */
    this._shock = damp(this._shock, 0, 3.6, dt);
    if (beat > this._shock) this._shock = beat;

    u.uTurb.value = damp(u.uTurb.value, 1.72 + level * 0.80, 4, dt);
    u.uStretch.value = damp(u.uStretch.value, 1.95 + level * 0.60, 4, dt);
    u.uHeight.value = damp(u.uHeight.value, 1.0 + level * 0.5 + this._shock * 0.14, 7, dt);
    u.uShock.value = damp(u.uShock.value, this._shock * 0.5, 10, dt);

    /* ── Cinematic rake ──────────────────────────────────────────────────────
       Driven by the morph (which is itself scroll-driven, so this still moves
       under reducedMotion — that is the content, not autonomous motion).

       CHAOS: a tight, dutch-angled knot held right of centre and high, beside
       the "Chaos / Control" headline and the RIFF SALAD card.
       CONTROL: the camera drops and levels off, and the ribbon settles LOW and
       WIDE across the bottom of the frame. Two reasons, and both of them are
       the reason the old framing failed:
         · by the time the morph completes, the reader is deep in the section
           and the copy occupies the top four fifths of the viewport. The only
           clean real estate is the floor.
         · a waterfall spectrogram only reads as parallel ridges receding into
           depth if you are looking slightly DOWN its length. Yawed 26° away
           and tipped 19° down puts every one of the 65 depth slices on a
           different scanline instead of collapsing them onto each other. */
    const m = u.uMorph.value;
    const pt = this._portrait;

    g.rotation.x = lerp(0.22, 0.34, m);
    g.rotation.y = lerp(-0.46, -0.20, m) + (p - 0.5) * 0.08;
    g.rotation.z = lerp(0.13, 0.00, m);

    g.position.set(
      pt ? lerp(0.9, 0.2, m) : lerp(3.0, 0.9, m),
      pt ? lerp(-2.2, -2.8, m) : lerp(-0.9, -2.05, m),
      pt ? -3.2 : lerp(-1.4, -0.6, m)
    );

    /* ── The left-column guard follows the composition ───────────────────────
       In chaos the mass is beside the body copy, so the guard has to be brutal.
       Once the ribbon has dropped to the floor of the frame there is nothing
       left to protect, and a hard guard would simply amputate its left third —
       so it relaxes into a gentle falloff with a much higher floor. */
    if (!pt) {
      const gx0 = lerp(-0.55, -1.15, m);
      const gx1 = lerp(0.35, -0.10, m);
      u.uGuard.value.set(gx0, gx1);
      u.uGuardMin.value = lerp(0.05, 0.30, m);
    }
  },

  dispose() {
    if (this._group) {
      this._group.removeFromParent();
      this._group.clear();
    }
    this._geo?.dispose();
    this._mat?.dispose();
    this._geo = this._mat = this._points = this._group = this._u = this._ctx = null;
  }
};
