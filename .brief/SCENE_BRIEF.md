# WebGL Scene Brief — shanejmbrower.com rebuild

## Who this is for
Shane J. M. Brower — a metal/indie **producer and mix engineer** in Jersey City.
Positioning: *"Mythos Amplified" / "Chaos control for bands with big ideas."*
His north star quote: **"I am not trying to make your song, I am trying to make Star Wars."**
He thinks about songs the way a director thinks about film: tension, release, scene changes.

The site must stand next to the best producer/studio sites in the world and win a
blind side-by-side. Restraint and craft beat spectacle. **A cheap-looking particle
demo is a failure.** Think: cinematic, filmic, physical, expensive.

## Brand palette (already exported from `gl/stage.js` as `PALETTE`)
- `void`   `#040605` — near-black with a green cast. The dominant colour by far.
- `moss`   `#101a15` — dark green, "the void we pull it from"
- `ember`  `#ff9a5a` / `ember2` `#f2743a` — energising pastel orange (the accent)
- `tide`   `#7fb4ff` / `tide2` `#a9d6ee` — calming pastel blue (the counterweight)
- `bone`   `#f4ede2` — bleached, aged-paper white

Rules: the page is **overwhelmingly dark**. Orange and blue are *accents in tension* —
never a 50/50 split, never rainbow, never neon/cyberpunk. Aim for the feel of a
long-exposure photograph or an anamorphic film frame: deep blacks, a few hot
highlights, gentle bloom, visible grain.

## The contract
Each scene is a plain object. Write **exactly one file**, export it as `default`.

```js
export default {
  id: 'hero',              // must match a [data-scene] value, or 'global'
  alwaysUpdate: false,     // true = update even when off-screen
  init(ctx) {},            // build geometry, add to ctx.world or ctx.backdrop
  update(ctx, dt, t, rec) {},  // rec = { el, progress, visible, rect } or null for 'global'
  resize(w, h) {},
  dispose() {}
}
```

`ctx` contains:
- `ctx.THREE` — the three.js namespace (v0.169). **Import three via `import * as THREE from 'three'`** — the importmap resolves it.
- `ctx.renderer` — shared WebGLRenderer
- `ctx.backdrop` — orthographic Scene, drawn first (full-screen shader work). Its camera is `ctx.cameraB`, an OrthographicCamera with frustum -1..1 on both axes. A `PlaneGeometry(2, 2)` fills the screen exactly.
- `ctx.world` — perspective Scene, drawn on top of the backdrop with `clear = false`. Camera `ctx.cameraW` is a PerspectiveCamera, fov 42, at `z = 12`, looking at the origin. It has `FogExp2`.
- `ctx.sizes` — `{ w, h, dpr }` in CSS pixels
- `ctx.state` — **live audio + scroll state, read this every frame**:
  - `state.level` 0..1 overall loudness (smoothed)
  - `state.bass`, `state.mid`, `state.treble` 0..1
  - `state.beat` 0..1, spikes on transients and decays
  - `state.playing` bool
  - `state.scroll`, `state.progress` 0..1 through the page, `state.velocity` px/frame
  - `state.reducedMotion`, `state.quality` (0.6 = degraded device, keep counts low)
- `ctx.sections` — `Map<id, {el, progress, visible, rect}>`; `progress` is 0..1 as the section crosses the viewport
- `ctx.palette` — the THREE.Color set above
- `ctx.bloom`, `ctx.grade` — the shared post passes. **Do not reconfigure them**; the stage drives them.

## Hard requirements
1. **Never block the main thread.** No sync loops over >200k items in `init`.
2. **Respect `state.reducedMotion`** — hold a still, composed frame; no motion.
3. **Respect `state.quality`** — halve particle counts / skip work when `< 1`.
4. **Dispose properly**: geometries, materials, textures, render targets.
5. **Additive/transparent particles must have `depthWrite: false`.**
6. Everything must degrade gracefully — if a texture fails to load, still render.
7. Prefer **one draw call** (`Points`, `InstancedMesh`, or a single fullscreen shader) over many meshes.
8. Use `ShaderMaterial` with GLSL you actually reason about. Comment the maths.
9. **Audio reactivity must be subtle when idle** — the scene has to look composed and
   beautiful with the music paused. Reactivity is seasoning, not the meal.
10. No external assets, no CDN, no new dependencies.

## Testing
The site is served at `http://localhost:8788`. **Do not open the browser** — a single
shared browser pane is used by the integrator. Verify by reading your code carefully
and by running `node`-free syntax checks if you like. Write correct code the first time.
