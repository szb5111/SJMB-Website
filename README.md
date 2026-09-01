# shanejmbrower.com — rebuild

A static, dependency-free site. No build step, no npm, no framework. Open it with any
static file server and it runs.

## Run it locally

```bash
python3 .serve.py 8788
```

Then open <http://localhost:8788>. (`.serve.py` sends `no-store` so edits show up
immediately — it's a dev convenience, not for production.)

Any static host works: Netlify, Cloudflare Pages, GitHub Pages, S3. Upload the folder.
The only requirement is that `.js` files are served as `text/javascript`.


## What's in the repo

The GitHub repo holds the **code only** — HTML, CSS, JS, vendored three.js,
fonts and the favicon. The media the site serves (`assets/audio/`,
`assets/video/`, `assets/img/`, `assets/art/`) is intentionally not committed;
it lives alongside the code locally. A fresh clone renders and runs, but the
player, reels and photography need those four folders dropped into `assets/`
(or the `.gitignore` entries removed and the media committed) before the site
is complete. Deploying straight from this repo alone will ship a site without
its media.

## Layout

```
index.html          the whole page, hand-authored and readable without JavaScript
styles/
  tokens.css        the brand as CSS variables — colours, type scale, spacing, motion
  base.css          reset, typography primitives, buttons, reveal system
  sections.css      per-section layout
  player.css        the listening station
  chrome.css        nav, drawer, preloader, cursor
src/
  content.js        the playlist + identity data (the only content JS owns)
  core/
    bus.js          shared state + one rAF loop for the whole site
    scroll.js       momentum smooth-scroll (off for reduced-motion / touch)
    audio.js        <audio> routed through Web Audio; exposes level/bass/mid/treble/beat
  ui/
    player.js       transport, playlist, scrubbing, keyboard, mini-dock
    waveform.js     real peak decoding + canvas rendering
    nav.js, cursor.js, reveal.js, preloader.js, hero-intro.js, video.js
  gl/
    stage.js        one WebGL context, two render layers, post chain, perf governor
    void.js         the atmospheric backdrop behind every section
    hero.js         the cymatic standing-wave plate
    chaos.js        the chaos → control morph
    record.js       the vinyl + dust in the listening section
assets/             audio, artwork, photography, video loops, self-hosted fonts
```

## Changing things

**Swap or add a track** — drop the MP3 in `assets/audio/`, the cover in `assets/art/`,
then add an entry to `TRACKS` in `src/content.js`. Each track carries its own `accent`
colour, which re-tints the player and the 3D scene while it plays. Nothing else needs
touching; the playlist, durations and waveforms are all derived.

**Change copy** — it's all in `index.html` as plain HTML. There is no CMS and no
templating; what you read is what ships.

**Change the palette** — `styles/tokens.css`. The 3D scenes restate the same colours as
sRGB floats in their shaders (see the note below), so if you change a brand colour,
search `src/gl/` for the old hex too.

## Things worth knowing

- **The site works without WebGL and without JavaScript.** If WebGL fails to initialise,
  `<html>` gets `.no-webgl` and the page renders as a normal, complete site. Every
  section is real HTML.
- **Colour space**: the final post-processing pass writes to the canvas without an
  sRGB encode, so the shaders author colour in display-referred sRGB rather than using
  three.js's linear `PALETTE` directly. This is deliberate and documented in each scene.
- **Performance**: a governor watches the frame rate and steps pixel ratio, bloom and
  particle counts down once if the device can't hold ~42fps.
- **Reduced motion**: `prefers-reduced-motion` disables smooth scroll, the marquee, the
  cursor, all entrance animation and all autonomous 3D motion. The scroll-driven
  chaos→control morph still works, because that's content, not decoration.
- **Audio** only starts on a real user gesture, per browser policy. OS media keys and
  the lock screen work via the Media Session API.

## Asset provenance

Audio and artwork are Shane's own portfolio work, pulled from the existing site's
player. Photography and video are from the supplied asset drop; the video loops were
trimmed and transcoded to 960×540 H.264 for the web (originals are multi-GB camera files
and are not in this folder).
