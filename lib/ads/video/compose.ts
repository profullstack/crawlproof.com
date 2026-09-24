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
  const headlineText = snapshot.headline;
  const headline = escapeHtml(headlineText);
  // Long copy has to come down or it wraps into the CTA; short copy should fill
  // the frame rather than float in the middle of it.
  const headlineSize = headlineText.length > 46 ? 88 : headlineText.length > 28 ? 116 : 148;
  // One span per word so each can enter on its own beat. Split on whitespace
  // only — a word is never broken, so no headline is ever half-drawn.
  const headlineWords = headlineText
    .split(/\s+/)
    .filter(Boolean)
    .map((w, i) => `<span class="w" data-i="${i}">${escapeHtml(w)}</span>`)
    .join(" ");
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
  /* Centred, not bottom-anchored. Anchored at the bottom the composition left
     the top half of a 1920x1080 frame empty, which is what made a five-second
     pre-roll read as a slide rather than an ad. */
  .copy{position:absolute;left:160px;right:160px;top:50%;transform:translateY(-50%);
    display:flex;flex-direction:column;gap:40px}
  .brand{display:flex;align-items:center;gap:24px}
  .logo{width:96px;height:96px;object-fit:contain;border-radius:20px}
  .logo--mono{display:grid;place-items:center;background:${accent};color:${bg};
    font-size:52px;font-weight:800}
  .domain{font-size:38px;letter-spacing:.02em;opacity:.86}
  /* Sized to the copy. A 20-character headline and an 80-character one cannot
     share a font size on a fixed frame without one of them looking wrong. */
  h1{font-size:${headlineSize}px;line-height:1.02;font-weight:800;letter-spacing:-.025em;
    text-shadow:0 2px 6px ${bg}e6,0 0 18px ${bg}bf}
  /* Each word animates in on its own, which is what makes the frame visibly
     progress instead of holding one pose for five seconds. */
  .w{display:inline-block;will-change:transform,opacity}
  .cta{display:inline-flex;align-items:center;gap:20px;align-self:flex-start;
    background:${accent};color:${bg};font-size:44px;font-weight:700;
    padding:26px 48px;border-radius:999px}
  .rule{height:8px;width:160px;background:${accent};border-radius:999px;transform-origin:left center}
</style></head>
<body><div class="stage">
  ${heroLayer}
  <div class="copy">
    <div class="brand">${mark}<span class="domain">${domain}</span></div>
    <div class="rule"></div>
    <h1>${headlineWords}</h1>
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
var brandEl = document.querySelector('.brand');
var ruleEl = document.querySelector('.rule');
var words = Array.prototype.slice.call(document.querySelectorAll('.w'));

function clamp01(v){ return v < 0 ? 0 : v > 1 ? 1 : v; }

// The whole animation, as a pure function of the frame index. Playwright calls
// this, waits for the returned promise to settle, then screenshots.
//
// Every value below is deliberately large. The previous version moved the copy
// 40px and scaled the artwork 4% across five seconds, which at 1920x1080 is
// invisible: frames one second apart were indistinguishable and the result was
// a still image with a duration. An ad has to visibly progress.
window.__seek = function (frame) {
  var s = frameState(frame, REDUCED);
  var t = frameTimeMs(frame);

  if (REDUCED) {
    // Everything at rest, immediately. A reduced-motion ad still ends on its
    // CTA; it simply never travels there.
    brandEl.style.opacity = 1; brandEl.style.transform = 'none';
    ruleEl.style.transform = 'scaleX(1)';
    words.forEach(function (w) { w.style.opacity = 1; w.style.transform = 'none'; });
    ctaEl.style.opacity = 1; ctaEl.style.transform = 'none';
    heroEl.style.transform = 'none';
    void stage.offsetHeight;
    return document.fonts ? document.fonts.ready : Promise.resolve();
  }

  // Beat 1 (0-700ms): the brand arrives and the accent rule draws across.
  var b = easeOut(clamp01(t / 500));
  // Floored, not faded from zero. Frame 0 has to show the advertiser's mark and
  // domain: the poster is cut from it, and a viewer who sees only the opening
  // instant should still know whose ad this is.
  brandEl.style.opacity = (0.35 + 0.65 * b).toFixed(3);
  brandEl.style.transform = 'translateX(' + ((1 - b) * -60).toFixed(2) + 'px)';
  ruleEl.style.transform = 'scaleX(' + b.toFixed(3) + ')';

  // Beat 2 (0-1200ms): the headline builds a word at a time, each rising into
  // place. Staggered so the eye is led along the line rather than shown a block.
  //
  // The whole build finishes inside the first quarter of the ad, and the first
  // word starts at t=0. An earlier version of this composition took 2.6s to
  // assemble, which spends half a five-second ad saying nothing — the same
  // objection that made the previous, motionless version wrong, in the other
  // direction.
  var per = words.length > 1 ? 800 / (words.length - 1) : 0;
  words.forEach(function (w, i) {
    var wp = easeOut(clamp01((t - i * per) / 420));
    w.style.opacity = wp.toFixed(3);
    w.style.transform = 'translateY(' + ((1 - wp) * 54).toFixed(2) + 'px)';
  });

  // Beat 3 (1900-2600ms): the CTA arrives, overshooting slightly so it lands
  // rather than fades. Early enough that it is on screen for nearly half the
  // ad, which is the part a viewer is meant to act on.
  var c = easeOut(clamp01((t - 1900) / 700));
  ctaEl.style.opacity = c.toFixed(3);
  ctaEl.style.transform = 'translateY(' + ((1 - c) * 40).toFixed(2) + 'px) scale(' + (0.9 + 0.1 * c).toFixed(3) + ')';

  // Throughout: a real push on the artwork. 12% over five seconds is visible
  // without pulling the eye off the copy; 4% was not.
  heroEl.style.transform = 'scale(' + (1 + 0.12 * (t / 5000)).toFixed(4) + ')';

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
