// The five-second composition, as a self-contained HTML document the worker
// screenshots frame by frame.
//
// Two properties matter more than how it looks:
//
//   * It is deterministic. Nothing reads a clock. The document exposes
//     `window.__seek(frame)` and every animated value is a pure function of
//     that frame index, so frame 73 is identical whether it was rendered first
//     or last, on a fast machine or a loaded one. A CSS animation or a
//     requestAnimationFrame loop would make the output depend on how quickly
//     Playwright got round to the screenshot, which is exactly the kind of
//     nondeterminism that turns a cached render hash into a lie.
//
//   * It is closed. Artwork arrives as a data: URI the caller has already
//     fetched and hashed; the document references no network origin, no local
//     file and no font service. A compositor that fetched a URL for itself
//     would be a request-forgery primitive pointed at our own infrastructure,
//     and it would also make renders depend on whatever that URL served today.

import { PREROLL_FRAMES, PREROLL_FPS, TIMELINE, frameTimeMs } from "./profiles";
import type { VideoDesignSnapshot } from "./snapshot";

/** Artwork the caller resolved, already fetched and inlined. */
export type ComposeAssets = {
  /** `data:image/...;base64,...` or null. */
  logo: string | null;
  hero: string | null;
};

/**
 * Copy is advertiser-controlled and lands inside a document a browser executes.
 * Escaping it is not defence-in-depth, it is the boundary: an advertiser who
 * can inject markup here runs script in the render container.
 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * A data: URI, or nothing.
 *
 * The compositor accepts only data: URIs for artwork. Anything else — an http
 * URL, a file path, a javascript: scheme — is dropped rather than sanitised,
 * because there is no legitimate caller that needs one and a partial sanitiser
 * is how the interesting ones get through.
 */
export function safeDataUri(uri: string | null): string | null {
  if (!uri) return null;
  return /^data:image\/(png|jpeg|webp|gif|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(uri) ? uri : null;
}

/** Cubic ease-out. Motion that decelerates reads as deliberate rather than mechanical. */
function easeOut(t: number): number {
  const c = Math.min(1, Math.max(0, t));
  return 1 - Math.pow(1 - c, 3);
}

/** Progress through a window, clamped to [0,1]. */
function phase(ms: number, startMs: number, endMs: number): number {
  if (endMs <= startMs) return ms >= endMs ? 1 : 0;
  return Math.min(1, Math.max(0, (ms - startMs) / (endMs - startMs)));
}

export type FrameState = {
  frame: number;
  timeMs: number;
  /** Headline/brand entrance: a short rise, already legible at frame 0. */
  entrance: number;
  /** Slow artwork drift across the hold. */
  drift: number;
  /** CTA emphasis over the final beat. */
  cta: number;
};

/**
 * The animated state at a frame. Exported because the test suite asserts the
 * timeline's shape directly rather than by decoding pixels, and because the
 * document below embeds this same function verbatim.
 */
export function frameState(frame: number, reducedMotion: boolean): FrameState {
  const timeMs = frameTimeMs(frame);
  if (reducedMotion) {
    // Same five-second timeline, no movement: every beat is already at rest.
    // The ad still *ends* on its CTA, it just never animates toward it.
    return { frame, timeMs, entrance: 1, drift: 0, cta: 1 };
  }
  return {
    frame,
    timeMs,
    entrance: easeOut(phase(timeMs, 0, TIMELINE.entranceEndMs)),
    drift: phase(timeMs, TIMELINE.entranceEndMs, TIMELINE.holdEndMs),
    cta: easeOut(phase(timeMs, TIMELINE.holdEndMs, TIMELINE.endMs)),
  };
}

function initial(s: string): string {
  const m = s.match(/[a-z0-9]/i);
  return m ? m[0].toUpperCase() : "★";
}

/**
 * The composition document.
 *
 * Laid out at 1920x1080 and scaled by the caller's viewport rather than
 * re-laid-out per rendition, so the 480p encode is a downscale of the same
 * pixels the 1080p master shows. Copy that fits the master therefore fits every
 * delivery rendition, which is the only way a legibility check at one size
 * means anything at the others.
 */
export function composeDocument(
  snapshot: VideoDesignSnapshot,
  assets: ComposeAssets = { logo: null, hero: null },
): string {
  const headline = escapeHtml(snapshot.headline);
  const cta = escapeHtml(snapshot.ctaText);
  const domain = escapeHtml(snapshot.domain);
  const logo = safeDataUri(assets.logo);
  const hero = safeDataUri(assets.hero);
  const font = escapeHtml(snapshot.fontFamily || "system-ui, -apple-system, Segoe UI, Roboto, sans-serif");

  // Colours are validated as hex by validateSnapshot() before a render is
  // queued; escaping them too means a bad one degrades to an inert attribute
  // rather than closing the style block.
  const bg = escapeHtml(snapshot.bgColor);
  const fg = escapeHtml(snapshot.fgColor);
  const accent = escapeHtml(snapshot.accentColor);

  const heroLayer = hero
    ? `<div class="hero" style="background-image:url('${hero}')"></div><div class="scrim"></div>`
    : `<div class="hero hero--none"></div>`;

  const mark = logo
    ? `<img class="logo" src="${logo}" alt="">`
    : `<div class="logo logo--mono">${escapeHtml(initial(snapshot.domain))}</div>`;

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>ad</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  html,body{width:1920px;height:1080px;overflow:hidden;background:${bg}}
  body{font-family:${font};color:${fg};-webkit-font-smoothing:antialiased}
  /* 10% safe area on every edge: the spec's requirement, and the reason the
     headline never touches a rendition's crop or a player's chrome. */
  .stage{position:relative;width:1920px;height:1080px}
  .hero{position:absolute;inset:0;background-size:cover;background-position:center}
  .hero--none{background:
    radial-gradient(120% 120% at 20% 0%, ${accent}22 0%, transparent 60%),${bg}}
  .scrim{position:absolute;inset:0;
    background:linear-gradient(180deg,${bg}1a 0%,${bg}99 62%,${bg}f2 100%)}
  .copy{position:absolute;left:192px;right:192px;bottom:108px;
    display:flex;flex-direction:column;gap:28px}
  .brand{display:flex;align-items:center;gap:22px}
  .logo{width:84px;height:84px;object-fit:contain;border-radius:18px}
  .logo--mono{display:grid;place-items:center;background:${accent};color:${bg};
    font-size:46px;font-weight:800}
  .domain{font-size:34px;letter-spacing:.02em;opacity:.86}
  h1{font-size:104px;line-height:1.05;font-weight:800;letter-spacing:-.02em;
    text-shadow:0 1px 2px ${bg}e6,0 0 12px ${bg}bf}
  .cta{display:inline-flex;align-items:center;gap:18px;align-self:flex-start;
    background:${accent};color:${bg};font-size:40px;font-weight:700;
    padding:22px 40px;border-radius:999px}
</style></head>
<body><div class="stage">
  ${heroLayer}
  <div class="copy">
    <div class="brand">${mark}<span class="domain">${domain}</span></div>
    <h1>${headline}</h1>
    <div class="cta">${cta}</div>
  </div>
</div>
<script>
${frameState.toString()}
${easeOut.toString()}
${phase.toString()}
var TIMELINE = ${JSON.stringify(TIMELINE)};
var PREROLL_FPS = ${PREROLL_FPS};
function frameTimeMs(frame){ return (frame / PREROLL_FPS) * 1000; }
var REDUCED = ${snapshot.reducedMotion ? "true" : "false"};
var stage = document.querySelector('.stage');
var copy = document.querySelector('.copy');
var heroEl = document.querySelector('.hero');
var ctaEl = document.querySelector('.cta');

// The whole animation, as a pure function of the frame index. Playwright calls
// this, waits for the returned promise to settle, then screenshots.
window.__seek = function (frame) {
  var s = frameState(frame, REDUCED);
  // Entrance: copy rises 40px and fades in over the first beat, from an
  // already-legible starting opacity rather than from nothing.
  copy.style.transform = 'translateY(' + ((1 - s.entrance) * 40).toFixed(3) + 'px)';
  copy.style.opacity = (0.55 + 0.45 * s.entrance).toFixed(4);
  // Drift: a 4% slow push on the artwork across the hold. Enough to stop the
  // frame reading as a still, small enough not to pull the eye off the copy.
  heroEl.style.transform = 'scale(' + (1 + 0.04 * s.drift).toFixed(4) + ')';
  // CTA: settles into place and brightens over the final beat.
  ctaEl.style.transform = 'scale(' + (0.96 + 0.04 * s.cta).toFixed(4) + ')';
  ctaEl.style.filter = 'brightness(' + (0.9 + 0.1 * s.cta).toFixed(4) + ')';
  // Force layout so the screenshot cannot catch a half-applied style.
  void stage.offsetHeight;
  return document.fonts ? document.fonts.ready : Promise.resolve();
};
window.__frames = ${PREROLL_FRAMES};
</script>
</body></html>`;
}

/**
 * Every frame's state, without a browser.
 *
 * The encoder needs the frame count and the tests need the timeline; neither
 * should have to launch Chromium to get them.
 */
export function timeline(reducedMotion: boolean): FrameState[] {
  return Array.from({ length: PREROLL_FRAMES }, (_, i) => frameState(i, reducedMotion));
}
