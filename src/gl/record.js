/**
 * record.js — "work" scene: THE LISTENING ROOM.
 *
 * The glass player card is the hero of this section. Everything here is the
 * *room around it*: a 12" record raked into the left third and cropped by the
 * frame like a photograph, and a whole volume of air made visible as dust.
 *
 * Two draw calls total:
 *   1. one RingGeometry disc, shaded entirely in GLSL (anisotropic vinyl)
 *   2. one THREE.Points dust field (8k / 16k depending on quality)
 *
 * The interesting part is the vinyl BRDF. A record is not a black donut with a
 * shiny dot on it: the grooves are concentric micro-cylinders, and a cylinder
 * has no single normal — it has a whole *circle* of normals perpendicular to
 * its axis. So the mirror condition is not `N == H` but `H ⟂ T`, and the
 * highlight stops being a dot and becomes a long arc smeared tangentially
 * around the disc. That is the entire reason vinyl is beautiful, and it is
 * implemented below (Kajiya–Kay lobe, see `vinylLight`).
 *
 * No `fwidth` anywhere: the groove pattern is band-limited with an ANALYTIC
 * screen-space footprint (see `uPxK`), which is both extension-free and gives
 * us exact control over where the grooves dissolve into a smooth sheen.
 */
import * as THREE from 'three';

/* ── frame-rate-independent helpers (kept local; this file owns them) ────── */
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const damp = (a, b, lambda, dt) => lerp(a, b, 1 - Math.exp(-lambda * dt));
const smoothstep = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };

/* ── colour handling ─────────────────────────────────────────────────────────
 * The post chain (stage.js) never applies an sRGB OETF — the grade pass writes
 * raw values to the default framebuffer. So every colour in this file is kept
 * DISPLAY-REFERRED (the literal hex numbers), not converted to linear. Passing
 * `LinearSRGBColorSpace` to setStyle() is the documented way to say "this is
 * already in the working space, don't touch it".
 */
function rawColor(hex, target = new THREE.Color()) {
  try { target.setStyle(hex, THREE.LinearSRGBColorSpace); } catch { target.setRGB(1, 1, 1); }
  return target;
}

const EMBER = rawColor('#ff9a5a');
const TIDE = rawColor('#7fb4ff');
const BONE = rawColor('#f4ede2');
const VOIDC = rawColor('#040605');
const MOSS = rawColor('#101a15');

/** Accepts #rgb / #rgba / #rrggbb / #rrggbbaa, with or without the hash. */
const HEX_RE = /^#?[0-9a-f]{3,8}$/i;
function parseAccent(value, out) {
  if (typeof value !== 'string') return out.copy(EMBER);
  const s = value.trim();
  if (!HEX_RE.test(s)) return out.copy(EMBER);
  const body = s[0] === '#' ? s.slice(1) : s;
  let hex;
  if (body.length === 3 || body.length === 4) hex = body.slice(0, 3);
  else if (body.length === 6 || body.length === 8) hex = body.slice(0, 6);
  else return out.copy(EMBER);
  try { out.setStyle('#' + hex, THREE.LinearSRGBColorSpace); } catch { out.copy(EMBER); }
  return out;
}

/* ── composition constants ──────────────────────────────────────────────── */
const DISC_Z = -2.6;            // pushed behind the player card
const DISC_RAKE_X = -1.22;      // ~70° tip — a proper raking angle, not face-on
const DISC_RAKE_Y = 0.26;
// Roll lives on the OUTER group, not on the disc. Three's default Euler order
// is XYZ ⇒ M = Rx·Ry·Rz, so a `rotation.z` alongside the rake would be applied
// in object space first — i.e. it would spin a rotationally-symmetric disc and
// change nothing at all. Applied one level up it is a real world-space roll,
// which is what tilts the ellipse off the horizontal.
const DISC_ROLL_Z = -0.30;
const HOLE = 0.038;             // spindle hole, in object units (outer radius = 1)
const SPIN_RPS = 1.12;          // rad/s while playing — slow, deliberate, expensive

/* ── shared GLSL: cheap value noise ─────────────────────────────────────── */
const NOISE_GLSL = /* glsl */`
  float hash21(vec2 p) {
    p = fract(p * vec2(123.34, 345.45));
    p += dot(p, p + 34.345);
    return fract(p.x * p.y);
  }
  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash21(i), b = hash21(i + vec2(1.0, 0.0));
    float c = hash21(i + vec2(0.0, 1.0)), d = hash21(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }
  float fbm(vec2 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 4; i++) { v += a * vnoise(p); p *= 2.03; a *= 0.5; }
    return v;
  }
`;

/* ══════════════════════ THE DISC ═══════════════════════════════════════ */

const DISC_VERT = /* glsl */`
  precision highp float;

  uniform float uTime;
  uniform float uWarp;   // dish amplitude (object units)
  uniform float uBass;

  varying vec3 vLocal;
  varying vec3 vWorld;
  varying vec3 vN;
  varying vec3 vEr;
  varying vec3 vEt;

  void main() {
    vec3 p = position;
    vLocal = p;

    float r = length(p.xy);
    float a = atan(p.y, p.x);
    float ca = cos(a), sa = sin(a);
    vec3 er = vec3(ca, sa, 0.0);    // radial     - ACROSS the grooves
    vec3 et = vec3(-sa, ca, 0.0);   // tangential - ALONG  the grooves

    // -- the warped record -----------------------------------------------
    // z = A*r^2*sin(2theta + phi): a two-lobe saddle, dead flat at the spindle and
    // strongest at the rim - exactly how an LP deforms after a hot car.
    // A is tiny; it exists so the highlight arc *breathes* with the bass
    // rather than to visibly bend the disc.
    float A = uWarp * (0.35 + uBass);
    float ang = 2.0 * a + uTime * 0.31;
    float s = sin(ang), c = cos(ang);
    p.z += A * r * r * s;

    // Analytic normal of that surface. For z = f(r,theta) the unit normal is
    // proportional to  z - er*(dz/dr) - et*(1/r)(dz/dtheta).
    float dzdr = A * 2.0 * r * s;         // dz/dr
    float dzdt = A * 2.0 * r * c;         // (1/r)*dz/dtheta = (1/r)*A*r^2*2c
    vec3 n = normalize(vec3(0.0, 0.0, 1.0) - er * dzdr - et * dzdt);

    // The group scale is uniform, so mat3(modelMatrix) is safe for directions
    // once re-normalised.
    mat3 nm = mat3(modelMatrix);
    vN  = normalize(nm * n);
    vEr = normalize(nm * er);
    vEt = normalize(nm * et);

    vec4 wp = modelMatrix * vec4(p, 1.0);
    vWorld = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const DISC_FRAG = /* glsl */`
  precision highp float;

  uniform vec3  uCam;
  uniform vec3  uKeyPos, uFillPos;
  uniform vec3  uGroove;      // highlight colour - damped toward the track accent
  uniform vec3  uTide, uBone, uEnvUp, uEnvDn;
  uniform vec3  uFogColor;
  uniform float uFogDensity;
  uniform float uDensity;     // grooves per object unit
  uniform float uPxK;         // world-units-per-pixel constant (see JS: analytic LOD)
  uniform float uTilt;        // groove-wall normal tilt
  uniform float uHot;         // level/beat driven highlight gain
  uniform float uLevel, uBeat;
  uniform float uFade;
  uniform float uKeyGain, uFillGain;

  varying vec3 vLocal;
  varying vec3 vWorld;
  varying vec3 vN;
  varying vec3 vEr;
  varying vec3 vEt;

  const float TAU = 6.28318530718;

  ${NOISE_GLSL}

  /**
   * One light against the vinyl surface.
   *
   * -- THE ANISOTROPIC HIGHLIGHT (the whole point of this file) ------------
   * A record's grooves are concentric micro-cylinders whose axis at any point
   * is the tangential direction T. A cylinder does not have one normal; every
   * direction perpendicular to T is a valid normal. So a half-vector H is
   * mirrored by SOME facet of the cylinder as soon as H is perpendicular to T
   * - regardless of where H sits in the plane perp to T.
   *
   * The correct lobe is therefore driven by
   *
   *      sin(T,H) = sqrt(1 - (T*H)^2)
   *
   * instead of the isotropic N*H. Two consequences, both of them the reason
   * vinyl photographs the way it does:
   *
   *  1. The bright set is where the groove runs perpendicular to H. Because
   *     the grooves are CIRCLES, that set is a radial locus through the disc,
   *     curved by the fact that the light is a real point in space rather
   *     than a direction - so it reads as a swept arc, not a straight bar.
   *  2. sin(T,H) falls off slowly as you travel ALONG a groove and quickly as
   *     you travel across it. The highlight is therefore STRETCHED
   *     TANGENTIALLY: a smear that follows the circumference. That tangential
   *     stretch is anisotropy, and it's what a "generic shiny spot" lacks.
   *
   * We evaluate it on Ts - the groove axis tilted by the local V-wall slope
   * - so adjacent groove walls throw their arcs at slightly different radii.
   * That is what breaks one broad smear into the fine comb of concentric
   * glints you actually see on a record.
   */
  vec3 vinylLight(
    vec3 Lp, vec3 lcol, float gain, float falloff,
    vec3 P, vec3 N, vec3 Nm, vec3 T, vec3 Ts, vec3 V,
    float fres, float grooveM, float mirrorM, float scuff)
  {
    vec3  dv  = Lp - P;
    float d2  = dot(dv, dv);
    vec3  L   = dv * inversesqrt(max(d2, 1e-6));
    float att = falloff / (falloff + d2);          // soft, non-physical inverse-square

    vec3 H = normalize(L + V);

    // anisotropic specular - sin(Ts,H) raised to two powers: one razor-tight
    // lobe for the glint comb, one broad lobe for the sheen that ties the
    // arc together across the disc.
    float th   = dot(Ts, H);
    float sin2 = max(1.0 - th * th, 0.0);          // = sin^2(Ts,H)
    float tight = pow(sin2, 45.0);                 // = sin^90 - the arc core
    float broad = pow(sin2, 4.0);                  // = sin^8  - the smear

    // anisotropic DIFFUSE (also Kajiya-Kay): sin(T,L). Keeps the unlit half
    // of the disc from crushing to pure black.
    float tl    = dot(T, L);
    float sheen = pow(max(1.0 - tl * tl, 0.0), 1.6);

    // Isotropic lobe for the polished lacquer. Under a raking light this is
    // almost always zero - smooth black lacquer really is black unless the
    // source's mirror image happens to land on it - which is exactly why the
    // track-gap lands read as DARK rings cutting the shimmer, not bright ones.
    float ndh = max(dot(Nm, H), 0.0);
    float iso = pow(ndh, 150.0) + pow(ndh, 18.0) * 0.06;

    vec3 c = vec3(0.0);
    c += lcol * (tight + broad * 0.085) * grooveM * (1.0 + scuff * 1.8);
    c += lcol * iso * (0.30 + mirrorM * 2.4);
    c *= fres * gain * att;
    c += lcol * sheen * 0.016 * att;               // ambient-ish wrap, not Fresnel-gated
    return c;
  }

  void main() {
    float r  = length(vLocal.xy);
    float rn = r;                                   // outer radius is exactly 1.0

    vec3 N  = normalize(vN);
    vec3 T  = normalize(vEt);
    vec3 Rd = normalize(vEr);
    vec3 dV = uCam - vWorld;
    float dist = length(dV);
    vec3 V  = dV / max(dist, 1e-5);

    float NdV = clamp(dot(N, V), 0.0, 1.0);
    // Schlick over vinyl's coating (F0 ~ 0.045). At the rake angle we shoot
    // this disc from, F climbs hard toward the far edge - which is precisely
    // why real record photos are brightest at the top of the ellipse.
    float F = 0.045 + 0.955 * pow(1.0 - NdV, 5.0);

    // -- analytic screen-space footprint (a hand-rolled mip-map) -----------
    // How many object-units of radius does one device pixel cover here?
    //   world-per-pixel = uPxK * dist   (uPxK folds in fov, resolution, scale)
    // and the radial axis is foreshortened by how edge-on it is to the eye.
    float rdv = dot(Rd, V);
    float fore = sqrt(max(1.0 - rdv * rdv, 1e-4));
    float rw = min(uPxK * dist / fore, 0.06);       // dradius per pixel (clamped for safety)
    float w1 = rw * uDensity;                       // dphase per pixel, octave 1
    float w2 = w1 * 3.0;                            // octave 2 is 3x finer

    // -- zones of a real LP -----------------------------------------------
    float label = 1.0 - smoothstep(0.318, 0.340, rn);
    float lead  = smoothstep(0.340, 0.372, rn) * (1.0 - smoothstep(0.388, 0.412, rn));
    float prog  = smoothstep(0.404, 0.436, rn) * (1.0 - smoothstep(0.926, 0.956, rn));
    float lip   = smoothstep(0.944, 0.974, rn);

    // the wider smooth land between songs
    float tf  = fract(rn * 5.0 + 0.35);
    float sep = clamp(smoothstep(0.930, 0.972, tf) - smoothstep(0.986, 1.0, tf), 0.0, 1.0);

    // -- the grooves ------------------------------------------------------
    // A real LP runs ~110 grooves/cm, far past what a pixel can hold. We pick
    // a density that RESOLVES on screen, then fade each octave out exactly
    // where its period drops below a pixel - the average of a sine is zero,
    // so the surface correctly relaxes to a smooth sheen instead of moire.
    float dens = uDensity * (1.0 + 0.055 * sin(rn * 23.0));   // pitch wander
    // (Nyquist bites at dphase = 0.5/px, so fade out across 0.22 - 0.68.)
    float ph = r * dens;
    float aa1 = 1.0 - smoothstep(0.22, 0.68, w1);
    float aa2 = 1.0 - smoothstep(0.22, 0.68, w2);
    float wall = (sin(ph * TAU) * aa1 + sin(ph * 3.0 * TAU) * aa2 * 0.55)
               / (1.0 + aa2 * 0.55);

    float grooveM = prog * (1.0 - sep * 0.9);
    float mirrorM = clamp(lead + lip + sep * prog, 0.0, 1.0) * (1.0 - label);

    // V-groove walls: alternating radial slope. Tilting the normal radially
    // gives the fine bright/dark ring texture...
    float tilt = uTilt * wall * grooveM;
    vec3 Nm = normalize(N + Rd * tilt);
    // ...and tilting the groove AXIS by the same amount displaces each wall's
    // anisotropic arc, which is what turns the smear into a comb of glints.
    vec3 Ts = normalize(T + N * (tilt * 0.8));

    // -- dust, scuffs, cleaning swirl -------------------------------------
    float la = atan(vLocal.y, vLocal.x);
    float dust = smoothstep(0.800, 0.945, fbm(vLocal.xy * 26.0 + 3.7));
    // scratches on a record are ARCS: constant radius, limited angular reach
    float scr = smoothstep(0.74, 0.99, vnoise(vec2(r * 62.0, la * 1.7 + 11.0)))
              * smoothstep(0.52, 0.86, vnoise(vec2(la * 2.4, r * 0.8)));
    scr *= aa1;                                     // don't alias the scratches either
    float swirl = fbm(vec2(la * 3.0, r * 5.0)) * 0.5;

    // -- lights -----------------------------------------------------------
    vec3 col = vec3(0.0);
    vec3 keyCol  = uGroove * uHot;
    vec3 fillCol = uTide * (0.55 + uLevel * 0.30);

    col += vinylLight(uKeyPos,  keyCol,  uKeyGain,  240.0,
                      vWorld, N, Nm, T, Ts, V, F, grooveM, mirrorM, scr + swirl * 0.25);
    col += vinylLight(uFillPos, fillCol, uFillGain, 420.0,
                      vWorld, N, Nm, T, Ts, V, F, grooveM, mirrorM, scr * 0.4);

    // -- body + a cheap studio environment --------------------------------
    // near-black with the brand's faint green cast; the reflection vector
    // samples a two-tone room (dark floor / cool ceiling) so the vinyl feels
    // like it's somewhere rather than floating.
    vec3 body = mix(vec3(0.0055, 0.0064, 0.0060), vec3(0.0105, 0.0112, 0.0118), rn);
    vec3 Rv = reflect(-V, Nm);
    vec3 env = mix(uEnvDn, uEnvUp, smoothstep(-0.55, 0.70, Rv.y));
    // the mirror-smooth lands reflect the room cleanly; the grooved bands
    // scatter it - that difference is all the lands need to read.
    col += body + env * (0.024 + F * 0.55) * (1.0 + mirrorM * 1.5);

    // dust only catches light at grazing angles, exactly as in life
    col += uBone * dust * (0.030 + F * 0.60) * (prog + lip * 0.5);
    col += uBone * scr * (0.012 + F * 0.34) * 0.6;

    // -- the label: matte paper, not plastic ------------------------------
    float paper = fbm(vLocal.xy * 46.0);
    vec3 labelCol = mix(vec3(0.017, 0.012, 0.0085), vec3(0.052, 0.036, 0.024), paper);
    vec3 Lk = normalize(uKeyPos - vWorld);
    float lam = max(dot(N, Lk), 0.0) * 0.60 + 0.30;      // soft Lambert
    float ring1 = 1.0 - smoothstep(0.0, 0.006, abs(rn - 0.300));
    float ring2 = 1.0 - smoothstep(0.0, 0.004, abs(rn - 0.148));
    // one printed sector, off-centre, so the rotation actually reads
    float sector = smoothstep(0.30, 0.96, 0.5 + 0.5 * cos(la - 1.1));
    float band = (1.0 - smoothstep(0.011, 0.017, abs(rn - 0.232))) * sector;
    labelCol += uGroove * (ring1 * 0.22 + ring2 * 0.11 + band * 0.10) * (0.45 + uLevel * 0.75);
    labelCol *= lam;
    labelCol *= smoothstep(0.036, 0.10, r);              // spindle shadow
    col = mix(col, labelCol, label);

    // -- the cool rim: tide wrapping the outer edge -----------------------
    float rim = smoothstep(0.958, 0.994, rn) * (1.0 - smoothstep(0.994, 1.0, rn));
    col += uTide * rim * (0.16 + F * 1.9) * (0.75 + uBeat * 0.45);
    col *= 1.0 - smoothstep(0.986, 1.0, rn) * 0.7;       // the lip rolls into shadow

    // -- depth ------------------------------------------------------------
    float fd = uFogDensity * dist;
    float fg = clamp(exp(-fd * fd), 0.0, 1.0);
    col = mix(uFogColor, col, fg);

    // -- analytic edge antialiasing (no MSAA in this renderer) -------------
    // The geometry runs 2% past rn = 1.0 and 25% inside the hole so there is
    // always room to feather both silhouettes over exactly one pixel.
    float rwe = min(rw, 0.006);                     // feather width, capped to the
    float aaOuter = 1.0 - smoothstep(1.0 - rwe, 1.0, rn);   // geometric margin below
    float aaInner = smoothstep(${HOLE.toFixed(3)} - rwe, ${HOLE.toFixed(3)}, rn);

    float alpha = uFade * aaOuter * aaInner;
    if (alpha < 0.002) discard;
    gl_FragColor = vec4(col, alpha);
  }
`;

/* ══════════════════════ THE DUST ═══════════════════════════════════════ */

const DUST_VERT = /* glsl */`
  precision highp float;

  uniform float uTime;
  uniform float uScale;       // px per world unit at unit distance
  uniform float uOpacity;
  uniform float uLevel, uBeat;
  uniform float uMotion;      // 0 under reduced-motion - one composed still
  uniform float uMinY, uSpanY;
  uniform float uHalfW;
  uniform float uFogDensity;

  attribute vec4 aRand;       // x: phase  y: speed  z: size  w: brightness
  attribute vec3 aColor;

  varying vec3  vCol;
  varying float vAlpha;

  void main() {
    vec3 p = position;
    float ph = aRand.x * 6.2831853;
    float sp = aRand.y;

    // a very slow overall rise, wrapped through the box so the field never
    // drains out the top
    float y = p.y + uTime * (0.040 + sp * 0.055) * uMotion;
    p.y = mod(y - uMinY, uSpanY) + uMinY;

    // Brownian-ish drift: incommensurate sines per axis, so the wander never
    // visibly repeats on any timescale a viewer will sit through
    float tt = uTime * (0.10 + sp * 0.13) * uMotion;
    p.x += (sin(tt + ph) + 0.55 * sin(tt * 1.73 + ph * 2.3)) * 0.36;
    p.y += (sin(tt * 0.83 + ph * 1.7) + 0.50 * sin(tt * 2.11 + ph * 0.9)) * 0.22;
    p.z += sin(tt * 1.21 + ph * 3.1) * 0.32;

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    float dist = max(-mv.z, 0.001);
    gl_Position = projectionMatrix * mv;

    gl_PointSize = clamp(aRand.z * (1.0 + uBeat * 0.20) * uScale / dist, 1.0, 34.0);

    // A shaft of light raking down through the room: motes only really glow
    // where they cross it. This is what sells "air", rather than "particles".
    // (squared by multiplication - pow() is undefined for a negative base,
    //  and this one goes negative across half the room)
    float sd = p.x * 0.30 + p.y * 0.62 + 1.2;
    float shaft = exp(-sd * sd * 0.10);
    float b = aRand.w * (0.26 + 1.20 * shaft);

    // hold the horizontal centre band quiet - the player card lives there
    b *= mix(0.42, 1.0, smoothstep(0.10, 0.62, abs(p.x) / uHalfW));

    b *= smoothstep(1.6, 6.5, dist);                       // nothing in your face
    float fd = uFogDensity * dist;
    b *= clamp(exp(-fd * fd), 0.0, 1.0);

    vCol = aColor;
    vAlpha = b * uOpacity * (0.72 + uLevel * 0.60 + uBeat * 0.34);
  }
`;

const DUST_FRAG = /* glsl */`
  precision highp float;
  varying vec3  vCol;
  varying float vAlpha;

  void main() {
    vec2 d = gl_PointCoord - 0.5;
    float r2 = dot(d, d);
    if (r2 > 0.25) discard;
    // a tight gaussian core plus a wide, very faint halo - reads as an
    // out-of-focus speck rather than a hard dot
    float halo = max(1.0 - r2 * 4.0, 0.0);
    float a = exp(-r2 * 15.0) * 0.85 + halo * halo * 0.22;
    gl_FragColor = vec4(vCol, a * vAlpha);
  }
`;

/* ══════════════════════ SCENE MODULE ═══════════════════════════════════ */

export default {
  id: 'work',
  alwaysUpdate: true,   // cheap early-out below; guarantees the fade reaches 0

  _ctx: null,
  _group: null,
  _rake: null,
  _disc: null,
  _dust: null,
  _discGeo: null,
  _discMat: null,
  _dustGeo: null,
  _dustMat: null,

  _fade: 0,
  _spin: 0,
  _angle: 0.42,
  _hot: 0.9,
  _bass: 0,
  _baseY: 0,
  _radius: 5,
  _pixPerWorld: 900,
  _grooveCol: EMBER.clone(),
  _accent: new THREE.Color(),
  _tmp: new THREE.Color(),

  init(ctx) {
    this._ctx = ctx;
    const THREEJS = ctx.THREE || THREE;
    const q = ctx.state?.quality ?? 1;

    // group (position / scale / world-space roll) → rake (the tip) → disc (spin)
    const group = new THREE.Group();
    group.rotation.z = DISC_ROLL_Z;
    group.renderOrder = 1;
    this._group = group;

    const rake = new THREE.Group();
    rake.rotation.set(DISC_RAKE_X, DISC_RAKE_Y, 0);
    group.add(rake);
    this._rake = rake;

    /* ── disc ──────────────────────────────────────────────────────────── */
    // Built at outer radius 1.0 (+2% of feather headroom) and scaled by the
    // group, so object space is always normalised and every zone constant in
    // the shader is a plain fraction of the record.
    const theta = q < 1 ? 180 : 288;
    const phi = q < 1 ? 28 : 44;
    this._discGeo = new THREEJS.RingGeometry(HOLE * 0.75, 1.02, theta, phi);

    const fogDensity = (ctx.world?.fog && ctx.world.fog.density) || 0.028;
    // NB: ctx.world.fog.color is a *linear* colour and would land at ~0.0015
    // through this (un-encoded) post chain — a crushed, dead black. Use the
    // display-referred `void` instead so distance reads as haze, not a hole.
    const fogColor = VOIDC.clone();

    this._discMat = new THREEJS.ShaderMaterial({
      vertexShader: DISC_VERT,
      fragmentShader: DISC_FRAG,
      transparent: true,
      depthWrite: true,
      depthTest: true,
      side: THREE.FrontSide,
      uniforms: {
        uTime:       { value: 0 },
        uWarp:       { value: 0.014 },
        uBass:       { value: 0 },
        uCam:        { value: new THREE.Vector3(0, 0, 12) },
        // ── the light rig ────────────────────────────────────────────────
        // Both sources sit almost IN the plane of the raked disc (≈78° off
        // its normal). That is not a stylistic choice: the anisotropic lobe
        // only collapses into a sharp arc when the half-vector H has a large
        // in-plane component. Light the disc from the front and H lines up
        // with N, sin(T,H) goes to ~1 everywhere, and the "arc" degenerates
        // into a flat grey wash. Raking light is what makes vinyl vinyl.
        uKeyPos:     { value: new THREE.Vector3(3.6, 0.2, -12.0) },   // warm, behind/right
        uFillPos:    { value: new THREE.Vector3(-16.9, 8.4, 6.0) },   // cool, high left
        uGroove:     { value: this._grooveCol },
        uTide:       { value: TIDE.clone() },
        uBone:       { value: BONE.clone() },
        uEnvUp:      { value: new THREE.Color().copy(TIDE).multiplyScalar(0.085).add(MOSS.clone().multiplyScalar(0.5)) },
        uEnvDn:      { value: new THREE.Color().copy(VOIDC).multiplyScalar(0.9) },
        uFogColor:   { value: fogColor },
        uFogDensity: { value: fogDensity },
        uDensity:    { value: 130 },
        uPxK:        { value: 0.0004 },
        uTilt:       { value: 0.34 },
        uHot:        { value: 0.9 },
        uLevel:      { value: 0 },
        uBeat:       { value: 0 },
        uFade:       { value: 0 },
        // Vinyl's Fresnel at this rake is only ~0.07, so the source has to be
        // genuinely bright for the arc to clear the bloom threshold (0.24).
        uKeyGain:    { value: 16.0 },
        uFillGain:   { value: 5.0 }
      }
    });

    this._disc = new THREEJS.Mesh(this._discGeo, this._discMat);
    this._disc.frustumCulled = false;
    // renderOrder does NOT inherit from a Group in three, so set it on the mesh:
    // the disc must draw (and write depth) before the additive dust, so that
    // motes behind the record are correctly occluded by it.
    this._disc.renderOrder = 1;
    this._disc.rotation.z = this._angle;
    rake.add(this._disc);

    /* ── dust ──────────────────────────────────────────────────────────── */
    const count = q < 1 ? 8000 : 16000;
    const BX = 20, YMIN = -12, YMAX = 12, ZMIN = -21, ZMAX = 6.5;
    const span = YMAX - YMIN;

    const pos = new Float32Array(count * 3);
    const rnd = new Float32Array(count * 4);
    const col = new Float32Array(count * 3);

    // Deterministic PRNG so the composition is identical on every load.
    let seed = 0x2f6e2b1;
    const rand = () => {
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
      return ((seed >>> 0) % 100000) / 100000;
    };

    const warm = new THREE.Color(0.62, 0.58, 0.52);
    for (let i = 0; i < count; i++) {
      const i3 = i * 3, i4 = i * 4;
      // bias x outward a little — keep the middle of the room emptier
      const rx = rand() * 2 - 1;
      pos[i3] = Math.sign(rx || 1) * Math.pow(Math.abs(rx), 0.72) * BX;
      pos[i3 + 1] = YMIN + rand() * span;
      pos[i3 + 2] = ZMIN + rand() * (ZMAX - ZMIN);

      rnd[i4] = rand();                                   // phase
      rnd[i4 + 1] = rand();                               // speed
      // most motes are tiny; a handful are big soft bokeh specks
      rnd[i4 + 2] = 0.011 + Math.pow(rand(), 3.4) * 0.085;
      // brightness: heavily skewed dim, a few hot ones
      rnd[i4 + 3] = 0.06 + Math.pow(rand(), 3.2) * 1.0;

      const pick = rand();
      let c = warm;
      if (pick > 0.86) c = EMBER;
      else if (pick > 0.76) c = TIDE;
      col[i3] = c.r; col[i3 + 1] = c.g; col[i3 + 2] = c.b;
    }

    this._dustGeo = new THREEJS.BufferGeometry();
    this._dustGeo.setAttribute('position', new THREEJS.BufferAttribute(pos, 3));
    this._dustGeo.setAttribute('aRand', new THREEJS.BufferAttribute(rnd, 4));
    this._dustGeo.setAttribute('aColor', new THREEJS.BufferAttribute(col, 3));

    this._dustMat = new THREEJS.ShaderMaterial({
      vertexShader: DUST_VERT,
      fragmentShader: DUST_FRAG,
      transparent: true,
      depthWrite: false,                 // required for additive particles
      depthTest: true,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uTime:       { value: 0 },
        uScale:      { value: 900 },
        uOpacity:    { value: 0 },
        uLevel:      { value: 0 },
        uBeat:       { value: 0 },
        uMotion:     { value: ctx.state?.reducedMotion ? 0 : 1 },
        uMinY:       { value: YMIN },
        uSpanY:      { value: span },
        uHalfW:      { value: 10 },
        uFogDensity: { value: fogDensity }
      }
    });

    this._dust = new THREEJS.Points(this._dustGeo, this._dustMat);
    this._dust.frustumCulled = false;    // vertices move in the shader
    this._dust.renderOrder = 2;

    group.visible = false;
    this._dust.visible = false;
    ctx.world.add(group);
    ctx.world.add(this._dust);

    // stage.resize() runs before modules are added, so lay out once here.
    this.resize(ctx.sizes.w, ctx.sizes.h);
  },

  /**
   * Composition: the record is sized and placed relative to the camera's world
   * frustum at its own depth, so it crops off the LEFT edge of the viewport at
   * every aspect ratio and its right edge always lands in the left third —
   * clear of the player card.
   */
  resize(w, h) {
    const ctx = this._ctx;
    if (!ctx || !this._group) return;

    const cam = ctx.cameraW;
    const aspect = (w || 1) / (h || 1);
    const dist = cam.position.z - DISC_Z;
    const halfH = Math.tan((cam.fov * Math.PI) / 360) * dist;
    const halfW = halfH * aspect;

    // radius scales with the frame, clamped so it never becomes a coin or
    // swallows an ultrawide monitor whole
    const R = clamp(halfW * 0.62, 3.2, 7.4);
    this._radius = R;

    // the disc's apparent horizontal half-extent after the rake (~0.92·R)
    const rightEdge = -halfW * 0.13;
    this._group.position.x = rightEdge - R * 0.92;
    this._baseY = -halfH * 0.09;
    this._group.position.y = this._baseY;
    this._group.position.z = DISC_Z;
    this._group.scale.setScalar(R);

    // device pixels per world unit at unit distance — the basis for both the
    // groove LOD and the dust point size
    const hPx = (h || 1) * (ctx.sizes.dpr || 1);
    this._pixPerWorld = (hPx * 0.5) / Math.tan((cam.fov * Math.PI) / 360);

    // groove density tracks CSS width so the look is identical on every
    // screen (the disc itself scales with the frame)
    this._discMat.uniforms.uDensity.value = clamp((w || 1400) * 0.078, 95, 215);

    this._dustMat.uniforms.uScale.value = this._pixPerWorld;
    const halfW0 = Math.tan((cam.fov * Math.PI) / 360) * cam.position.z * aspect;
    this._dustMat.uniforms.uHalfW.value = Math.max(halfW0, 1);
  },

  update(ctx, dt, t, rec) {
    const s = ctx.state;
    const g = this._group;
    if (!g) return;

    /* ── section fade ────────────────────────────────────────────────────
     * progress is 0 as the section enters from below and 1 once it has left
     * above; hold the room lit only across the middle so nothing bleeds into
     * the neighbouring scenes. */
    const p = rec ? rec.progress : 0.5;
    const target = smoothstep(0.05, 0.27, p) * (1 - smoothstep(0.73, 0.97, p));
    this._fade = damp(this._fade, target, 5.5, dt);
    if (Math.abs(this._fade - target) < 0.004) this._fade = target;

    const fade = this._fade;
    const lit = fade > 0.003;
    g.visible = lit;
    this._dust.visible = lit;
    // a fully faded disc must stop writing depth or it punches an invisible
    // hole through the dust behind it
    this._discMat.depthWrite = fade > 0.05;
    if (!lit) return;

    const reduced = !!s.reducedMotion;
    const du = this._dustMat.uniforms;
    const di = this._discMat.uniforms;

    /* ── rotation: real inertia, never a snap ───────────────────────────── */
    if (reduced) {
      this._spin = 0;
      this._angle = 0.42;
    } else {
      const spinTarget = s.playing ? SPIN_RPS : 0;
      // spins up briskly, coasts down slowly — a heavy platter, not a switch
      const lambda = s.playing ? 0.85 : 0.32;
      this._spin = damp(this._spin, spinTarget, lambda, dt);
      // a whisper of wow & flutter so the turn never feels digital
      this._angle += this._spin * dt * (1 + Math.sin(t * 0.63) * 0.008);
      this._angle %= Math.PI * 2;   // keep float32 matrix precision perfect forever
    }
    this._disc.rotation.z = this._angle;

    /* ── audio seasoning (subtle by default) ────────────────────────────── */
    /* Reduced motion silences the audio drive completely. `uBass` and `uTime`
       were already gated, but `level` and `beat` were not — so with the player
       running, a reduced-motion visitor still got a disc whose highlight gain
       pumped on every kick and whose dust motes changed size on the beat. A
       pulsing still frame is not a still frame. */
    this._bass = damp(this._bass, reduced ? 0 : (s.bass || 0), 7, dt);
    const level = reduced ? 0 : (s.level || 0);
    const beat = reduced ? 0 : (s.beat || 0);

    /* Groove-highlight gain: composed at 0.9 with the music stopped.
       The audio drive was +1.15·level +0.42·beat, i.e. up to 2.6x on a loud
       passage. Measured against a sustained level of 0.8 the specular arc hit
       255,249,229 and clipped — the record stopped being black vinyl catching a
       light and became a white flare. At +0.62/+0.26 the arc still visibly
       breathes with the track but its hottest pixel stays inside the range,
       which is the difference between "lit" and "blown". */
    this._hot = damp(this._hot, 0.9 + level * 0.62 + beat * 0.26, 8, dt);
    di.uHot.value = this._hot;
    di.uLevel.value = level;
    di.uBeat.value = beat;
    di.uBass.value = this._bass;
    di.uTime.value = reduced ? 0 : t;
    di.uFade.value = fade;

    // tiny bass wobble on the disc scale — a warped record breathing
    const pulse = 1 + this._bass * 0.006 + beat * 0.002;   // both already 0 when reduced
    g.scale.setScalar(this._radius * pulse);
    di.uPxK.value = 1 / Math.max(this._radius * pulse * this._pixPerWorld, 1e-4);

    /* ── the light re-tunes to the current track ────────────────────────── */
    parseAccent(s.accent, this._accent);
    // keep 22% of the brand ember in it so the room stays this brand's room
    this._tmp.copy(this._accent).lerp(EMBER, 0.22);
    this._grooveCol.r = damp(this._grooveCol.r, this._tmp.r, 1.8, dt);
    this._grooveCol.g = damp(this._grooveCol.g, this._tmp.g, 1.8, dt);
    this._grooveCol.b = damp(this._grooveCol.b, this._tmp.b, 1.8, dt);

    /* ── parallax: the record drifts against the scroll ─────────────────── */
    if (!reduced) {
      g.position.y = this._baseY + (0.5 - p) * 1.7;
      g.rotation.z = DISC_ROLL_Z + Math.sin(t * 0.07) * 0.02;
    } else {
      g.position.y = this._baseY;
      g.rotation.z = DISC_ROLL_Z;
    }

    /* ── the key light drifts, so the arc sweeps ─────────────────────────
     * Both sources are anchored to the disc's own centre so the rig survives
     * every aspect ratio, and both were solved against the disc's actual
     * world normal — N ≈ (0.514, 0.791, 0.332) — to sit ~78° off it. The key
     * orbits in AZIMUTH ONLY: changing elevation would flatten the arc back
     * into a wash, whereas walking the azimuth sweeps the arc around the
     * record over roughly two minutes. */
    const cx = g.position.x, cy = g.position.y, cz = g.position.z;
    const az = -0.731 + (reduced ? 0 : Math.sin(t * 0.055) * 0.30);
    di.uKeyPos.value.set(
      cx + Math.cos(az) * 14.0,
      cy + 0.7 + (reduced ? 0 : Math.sin(t * 0.041) * 0.9),
      cz + Math.sin(az) * 14.0
    );
    di.uFillPos.value.set(cx - 10.1, cy + 8.9, cz + 8.6);
    di.uCam.value.copy(ctx.cameraW.position);

    /* ── dust ────────────────────────────────────────────────────────────── */
    du.uTime.value = t;
    du.uLevel.value = level;
    du.uBeat.value = beat;
    du.uMotion.value = reduced ? 0 : 1;
    du.uOpacity.value = fade * 0.62;
  },

  dispose() {
    const ctx = this._ctx;
    if (ctx?.world) {
      if (this._group) ctx.world.remove(this._group);
      if (this._dust) ctx.world.remove(this._dust);
    }
    this._discGeo?.dispose();
    this._discMat?.dispose();
    this._dustGeo?.dispose();
    this._dustMat?.dispose();
    this._group = this._rake = this._disc = this._dust = null;
    this._discGeo = this._discMat = this._dustGeo = this._dustMat = null;
    this._ctx = null;
  }
};
