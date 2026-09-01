/**
 * stage.js — one WebGL context for the whole site.
 *
 * Two render layers share a single canvas and post chain:
 *
 *   backdrop  — an orthographic layer for full-screen shader work (the void,
 *               nebulae, gradients). Rendered first, never depth-tested.
 *   world     — a perspective layer for actual geometry (particle fields,
 *               the record, the chaos→control mass).
 *
 * Scene modules are plain objects implementing the SceneModule contract below.
 * They are handed a context and are expected to add/remove their own objects
 * and dispose their own resources. Nothing else in the codebase touches three.
 *
 * SceneModule = {
 *   id: string,                       // must match a [data-scene] section id, or 'global'
 *   init(ctx): void,
 *   update(ctx, dt, t): void,         // called every frame while visible (and once after)
 *   resize?(w, h): void,
 *   dispose?(): void,
 *   alwaysUpdate?: boolean            // update even when off-screen (default false)
 * }
 *
 * ctx = {
 *   THREE, renderer, backdrop, world, cameraB, cameraW, sizes,
 *   state,                            // the shared runtime state (audio + scroll)
 *   sections: Map<id, {el, progress, visible, rect}>,
 *   palette,                          // brand colours as THREE.Color
 *   quality                           // 0.5..1
 * }
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { state, onFrame, clamp, damp } from '../core/bus.js';

/* ── Brand palette, as linear-space colours ─────────────────────────────── */
export const PALETTE = {
  void:   new THREE.Color('#040605'),
  moss:   new THREE.Color('#101a15'),
  ember:  new THREE.Color('#ff9a5a'),
  ember2: new THREE.Color('#f2743a'),
  tide:   new THREE.Color('#7fb4ff'),
  tide2:  new THREE.Color('#a9d6ee'),
  bone:   new THREE.Color('#f4ede2')
};

/* ── Final grade: chromatic aberration, vignette, grain, filmic curve ───── */
const GradeShader = {
  uniforms: {
    tDiffuse:   { value: null },
    uTime:      { value: 0 },
    uAberration:{ value: 0.00052 },
    uVignette:  { value: 0.42 },
    uGrain:     { value: 0.055 },
    uGrainScale:{ value: 1 / 2.2 },   // 1 / (device px per grain cell)
    uExposure:  { value: 1.02 },
    uSaturation:{ value: 1.06 },
    uLevel:     { value: 0 }
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */`
    precision highp float;
    uniform sampler2D tDiffuse;
    uniform float uTime, uAberration, uVignette, uGrain, uGrainScale, uExposure, uSaturation, uLevel;
    varying vec2 vUv;

    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

    // ACES-inspired filmic tonemap — keeps highlights from turning to paste.
    vec3 tonemap(vec3 x) {
      const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
      return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
    }

    void main() {
      vec2 uv = vUv;
      vec2 dir = uv - 0.5;
      float r2 = dot(dir, dir);

      /* Radial chromatic aberration.
         This runs on top of two scenes made of ~1px additive points. Any
         displacement bigger than a pixel does not read as "a lens" — it tears
         each grain into a red ghost, a green core and a blue ghost, i.e. green
         and magenta confetti over the whole particle field. So the budget here
         is sub-pixel at the centre and barely over one pixel in the corners of
         a 1440-wide frame, and the music is allowed to widen it by 25%, not by
         180%. You should only ever notice this on the type at the far corners. */
      float amt = uAberration * (1.0 + r2 * 1.15) * (1.0 + uLevel * 0.25);
      vec3 col;
      col.r = texture2D(tDiffuse, uv - dir * amt).r;
      col.g = texture2D(tDiffuse, uv).g;
      col.b = texture2D(tDiffuse, uv + dir * amt).b;

      col *= uExposure;
      col = tonemap(col);

      // saturation
      float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(vec3(luma), col, uSaturation);

      // vignette
      col *= 1.0 - uVignette * smoothstep(0.18, 0.92, r2 * 1.6);

      /* Film grain.
         Keyed to gl_FragCoord (device pixels) rather than uv, so the grain has
         the SAME apparent size on a 1x laptop and a 2x retina panel — keying it
         to uv made the cell 0.75px on one and 1.4px on the other, which is the
         difference between sparkle and mush.
         uGrainScale is 1/(device px per cell), set from the dpr so the cell is
         a constant ~1.5 CSS px on a 1x panel and on a retina one alike.
         The time term is quantised to 24 exposures a second. Re-rolling the
         field at 120Hz reads as electronic noise; 24Hz reads as film. */
      vec2 gp = floor(gl_FragCoord.xy * uGrainScale);
      float g = hash(gp + vec2(uTime, uTime * 1.37)) - 0.5;
      col += g * uGrain * (0.25 + luma * 0.9);

      gl_FragColor = vec4(col, 1.0);
    }
  `
};

export function createStage(canvas) {
  const sizes = { w: window.innerWidth, h: window.innerHeight, dpr: 1 };

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false,          // FXAA-free: bloom + grain hide edges, and this is much cheaper
    alpha: false,
    powerPreference: 'high-performance',
    stencil: false,
    depth: true
  });
  renderer.setClearColor(PALETTE.void, 1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;   // we tonemap in the grade pass

  const backdrop = new THREE.Scene();
  const world = new THREE.Scene();
  world.fog = new THREE.FogExp2(PALETTE.void.getHex(), 0.028);

  const cameraB = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const cameraW = new THREE.PerspectiveCamera(42, 1, 0.1, 160);
  cameraW.position.set(0, 0, 12);

  /* ── Post chain ──────────────────────────────────────────────────────── */
  const composer = new EffectComposer(renderer);
  const backdropPass = new RenderPass(backdrop, cameraB);
  const worldPass = new RenderPass(world, cameraW);
  worldPass.clear = false;                       // composite on top of the backdrop
  const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.62, 0.72, 0.24);
  const grade = new ShaderPass(GradeShader);
  grade.renderToScreen = true;

  composer.addPass(backdropPass);
  composer.addPass(worldPass);
  composer.addPass(bloom);
  composer.addPass(grade);

  /* ── Section tracking ────────────────────────────────────────────────── */
  const sections = new Map();
  function indexSections() {
    sections.clear();
    document.querySelectorAll('[data-scene]').forEach((el) => {
      sections.set(el.dataset.scene, { el, progress: 0, visible: false, rect: el.getBoundingClientRect() });
    });
  }
  indexSections();

  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const rec = sections.get(e.target.dataset.scene);
      if (rec) rec.visible = e.isIntersecting;
    }
  }, { rootMargin: '20% 0px 20% 0px' });
  sections.forEach((rec) => io.observe(rec.el));

  const ctx = {
    THREE, renderer, composer, backdrop, world, cameraB, cameraW, sizes,
    state, sections, palette: PALETTE, quality: 1, bloom, grade
  };

  /* ── Scene registry ──────────────────────────────────────────────────── */
  const modules = [];
  function add(mod) {
    try {
      mod.init?.(ctx);
      modules.push(mod);
    } catch (err) { console.error(`[stage] "${mod.id}" failed to init`, err); }
    return mod;
  }

  /* ── Resize ──────────────────────────────────────────────────────────── */
  function resize() {
    /* Measure the CANVAS, not the window. With a classic scrollbar the canvas
       is ~15px narrower than window.innerWidth; sizing the drawing buffer to
       the window stretched the whole render horizontally by ~1% — invisible on
       a gradient, very visible on a record that is supposed to be a circle. */
    const cw = canvas.clientWidth || window.innerWidth;
    const ch = canvas.clientHeight || window.innerHeight;
    sizes.w = cw;
    sizes.h = ch;
    sizes.dpr = Math.min(window.devicePixelRatio || 1, ctx.quality >= 1 ? 1.85 : 1.25);

    renderer.setPixelRatio(sizes.dpr);
    renderer.setSize(sizes.w, sizes.h, false);
    composer.setPixelRatio(sizes.dpr);
    composer.setSize(sizes.w, sizes.h);
    bloom.setSize(sizes.w * sizes.dpr, sizes.h * sizes.dpr);

    cameraW.aspect = sizes.w / sizes.h;
    cameraW.updateProjectionMatrix();

    // one grain cell ≈ 1.5 CSS px on every display, whatever the dpr
    grade.uniforms.uGrainScale.value = 1 / Math.max(sizes.dpr * 1.5, 1);

    for (const m of modules) { try { m.resize?.(sizes.w, sizes.h); } catch (err) { console.error(err); } }
    for (const rec of sections.values()) rec.rect = rec.el.getBoundingClientRect();
  }

  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(resize, 120);
  });
  resize();

  /* ── Performance governor ────────────────────────────────────────────
     Two traps to avoid:
     - An occluded window gets rAF throttled to ~1-4fps by the browser while
       the GPU is idle. That is not a slow device; below 15fps we ignore the
       window entirely rather than punish a capable machine.
     - A single congested window (tab switch, decode burst) is noise, so a
       step down needs two consecutive slow-but-running windows, and a
       recovered machine earns its quality back the same way. */
  let frames = 0, acc = 0, degraded = false, slowRuns = 0, fastRuns = 0;
  function setQuality(q, note) {
    degraded = q < 1;
    ctx.quality = q;
    state.quality = q;
    bloom.strength = degraded ? 0.42 : 0.56;
    resize();
    console.info(`[stage] ${note}`);
  }
  function governor(dt) {
    frames++; acc += dt;
    if (acc < 2) return;
    const fps = frames / acc;
    frames = 0; acc = 0;

    if (fps < 15) { slowRuns = 0; fastRuns = 0; return; }   // throttled, not slow

    if (!degraded && fps < 42) {
      if (++slowRuns >= 2) { slowRuns = 0; setQuality(0.6, `stepping down for performance (${fps.toFixed(0)}fps)`); }
    } else { slowRuns = 0; }

    if (degraded && fps > 56) {
      if (++fastRuns >= 2) { fastRuns = 0; setQuality(1, `restoring quality (${fps.toFixed(0)}fps)`); }
    } else { fastRuns = 0; }
  }

  /* ── Frame ───────────────────────────────────────────────────────────── */
  let running = true;
  document.addEventListener('visibilitychange', () => { running = !document.hidden; });

  onFrame((dt, t) => {
    if (!running) return;
    governor(dt);

    // Update each section's 0..1 progress through the viewport.
    for (const rec of sections.values()) {
      const r = rec.el.getBoundingClientRect();
      rec.rect = r;
      rec.progress = clamp(1 - (r.top + r.height) / (sizes.h + r.height));
    }

    for (const m of modules) {
      const rec = m.id === 'global' ? null : sections.get(m.id);
      if (!m.alwaysUpdate && rec && !rec.visible) continue;
      try { m.update?.(ctx, dt, t, rec); } catch (err) { console.error(`[stage] "${m.id}" update`, err); }
    }

    /* Music drives the grade: louder → hotter exposure, a whisper more bloom.
       Grain steps at 24Hz and is held completely still under reduced motion —
       a background that fizzes is still a background that moves. The value is
       wrapped to 0..63 so the hash never loses precision on a long session. */
    /* Reduced motion has to reach the POST CHAIN too, not just the scenes.
       Every scene gates its own audio drive, but exposure, bloom strength and
       the aberration width are global: left ungated they pumped the entire
       frame on every beat, so a visitor who asked for no motion still got the
       whole page breathing at 120bpm. `drive` is the single switch. */
    const drive = state.reducedMotion ? 0 : 1;
    const lvl = state.level * drive;
    const bt  = state.beat * drive;

    grade.uniforms.uTime.value = state.reducedMotion ? 7 : Math.floor(t * 24) % 64;
    grade.uniforms.uLevel.value = lvl;
    grade.uniforms.uExposure.value = damp(grade.uniforms.uExposure.value, 1.0 + lvl * 0.16, 5, dt);
    /* Bloom ceiling matters: the record's specular arc already sits near 220/255
       before bloom, so a strength that ran to 1.26 on a loud passage turned the
       whole disc into a flare. Capped at ~0.95. */
    bloom.strength = damp(
      bloom.strength,
      (ctx.quality >= 1 ? 0.56 : 0.4) + lvl * 0.28 + bt * 0.11,
      6, dt
    );

    composer.render();
  });

  return { ctx, add, resize, renderer, composer };
}
