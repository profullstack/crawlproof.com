// The animated banner document.
//
// Same contract as the pre-roll compositor: the page defines `window.__seek(n)`
// and every animated value is a pure function of the frame index, so the
// renderer drives time explicitly instead of screenshotting a wall clock and
// hoping. That is what makes a capture reproducible.
//
// What differs is the layout. The pre-roll lays out once at 1920x1080 and lets
// each rendition downscale the same pixels; a banner cannot work that way,
// because 320x50 is not a scaled 300x250 — it is a different composition with
// different copy priorities. So each unit is laid out at its own native size,
// mirroring the static creative it replaces: the rectangle stacks, the
// leaderboard and mobile banner run as a row.
//
// The motion is deliberately the pre-roll's, not a new vocabulary: a short
// entrance rise, a slow accent drift through the hold, and a CTA that gains
// emphasis on the final beat. An advertiser who has seen their video should
// recognise the banner as the same campaign.

import { GIF_FPS, GIF_FRAMES } from "../video/profiles";
import { escapeHtml, safeDataUri } from "../video/compose";

export type GifUnit = {
  id: "gif_300x250" | "gif_728x90" | "gif_320x50";
  width: number;
  height: number;
  /** Row units put the mark, copy and CTA on one line. */
  row: boolean;
  /** The mobile banner has no room for a body line. */
  showBody: boolean;
};

export const GIF_UNITS: GifUnit[] = [
  { id: "gif_300x250", width: 300, height: 250, row: false, showBody: true },
  { id: "gif_728x90", width: 728, height: 90, row: true, showBody: true },
  { id: "gif_320x50", width: 320, height: 50, row: true, showBody: false },
];

export function gifUnit(id: string): GifUnit {
  const u = GIF_UNITS.find((x) => x.id === id);
  if (!u) throw new Error(`Unknown animated banner unit: ${id}`);
  return u;
}

/** Beat boundaries, in milliseconds of a 4s loop. */
export const GIF_TIMELINE = {
  entranceEndMs: 700,
  holdEndMs: 2800,
  endMs: 4000,
} as const;

export type GifFrameState = {
  frame: number;
  timeMs: number;
  entrance: number;
  drift: number;
  cta: number;
  /** The accent sweep's position, -1 to 2 across the unit. */
  sweep: number;
};

function easeOut(t: number): number {
  const c = Math.min(1, Math.max(0, t));
  return 1 - Math.pow(1 - c, 3);
}

function phase(ms: number, startMs: number, endMs: number): number {
  if (endMs <= startMs) return ms >= endMs ? 1 : 0;
  return Math.min(1, Math.max(0, (ms - startMs) / (endMs - startMs)));
}

/**
 * The animated state at a frame.
 *
 * Exported so tests can assert the timeline's shape without decoding pixels,
 * and because the document below embeds this same function verbatim.
 */
export function gifFrameState(frame: number, reducedMotion: boolean): GifFrameState {
  const timeMs = (frame / GIF_FPS) * 1000;
  if (reducedMotion) {
    // A still banner, held at its resting state. It still reads as the finished
    // ad — headline up, CTA emphasised — it simply never moves toward it.
    return { frame, timeMs, entrance: 1, drift: 0, cta: 1, sweep: 2 };
  }
  return {
    frame,
    timeMs,
    entrance: easeOut(phase(timeMs, 0, GIF_TIMELINE.entranceEndMs)),
    drift: phase(timeMs, GIF_TIMELINE.entranceEndMs, GIF_TIMELINE.holdEndMs),
    cta: easeOut(phase(timeMs, GIF_TIMELINE.holdEndMs, GIF_TIMELINE.endMs)),
    // One pass across the unit during the hold. Starts off-screen and ends
    // off-screen, so the loop point never shows a sweep frozen mid-unit.
    sweep: -1 + 3 * phase(timeMs, GIF_TIMELINE.entranceEndMs, GIF_TIMELINE.holdEndMs),
  };
}

export function gifTimeline(reducedMotion: boolean): GifFrameState[] {
  return Array.from({ length: GIF_FRAMES }, (_, i) => gifFrameState(i, reducedMotion));
}

function initial(s: string): string {
  const m = s.match(/[a-z0-9]/i);
  return m ? m[0].toUpperCase() : "★";
}

export type GifComposeInput = {
  unit: GifUnit;
  headline: string;
  body: string;
  ctaText: string;
  domain: string;
  bgColor: string;
  fgColor: string;
  accentColor: string;
  fontFamily: string;
  logoDataUri: string | null;
  reducedMotion: boolean;
};

/**
 * A self-contained, offline document for one animated banner.
 *
 * No network references survive: the logo arrives as a data URI or not at all,
 * and the font stack is whatever the rendering container has. A banner that
 * waits on a webfont would capture its first frames unstyled, and every one of
 * those frames ships.
 */
export function gifDocument(input: GifComposeInput): string {
  const {
    unit,
    headline,
    body,
    ctaText,
    domain,
    bgColor,
    fgColor,
    accentColor,
    fontFamily,
    logoDataUri,
    reducedMotion,
  } = input;

  const logo = safeDataUri(logoDataUri);
  const markSize = unit.id === "gif_320x50" ? 20 : 28;
  const headlineSize = unit.id === "gif_320x50" ? 13 : unit.row ? 16 : 18;
  const bodySize = unit.row ? 12 : 13;
  const ctaPad = unit.id === "gif_320x50" ? "4px 8px" : "7px 12px";
  const ctaSize = unit.id === "gif_320x50" ? 11 : 13;

  const mark = logo
    ? `<img id="mark" src="${logo}" alt="" style="height:${markSize}px;width:auto;max-width:${markSize * 3}px;border-radius:4px;object-fit:contain;flex:0 0 auto">`
    : `<div id="mark" style="height:${markSize}px;width:${markSize}px;border-radius:6px;flex:0 0 auto;display:flex;align-items:center;justify-content:center;background:${accentColor};color:${bgColor};font-weight:700;font-size:${Math.round(markSize * 0.5)}px">${escapeHtml(initial(domain))}</div>`;

  const copy = `
    <div id="copy" style="display:flex;flex-direction:column;gap:3px;min-width:0;flex:1 1 auto">
      <div id="headline" style="font-weight:700;font-size:${headlineSize}px;line-height:1.15;color:${fgColor};overflow:hidden;text-overflow:ellipsis;${unit.id === "gif_320x50" ? "white-space:nowrap" : ""}">${escapeHtml(headline)}</div>
      ${unit.showBody ? `<div id="body" style="font-size:${bodySize}px;line-height:1.3;color:${fgColor};opacity:.85;overflow:hidden;text-overflow:ellipsis">${escapeHtml(body)}</div>` : ""}
    </div>`;

  const cta = `<div id="cta" style="flex:0 0 auto"><span style="display:inline-block;background:${accentColor};color:${bgColor};font-weight:600;border-radius:6px;padding:${ctaPad};font-size:${ctaSize}px;white-space:nowrap">${escapeHtml(ctaText)}</span></div>`;

  const inner = unit.row
    ? `<div class="stage" style="display:flex;align-items:center;gap:12px;width:100%;height:100%;padding:0 12px">${mark}${copy}${cta}</div>`
    : `<div class="stage" style="display:flex;flex-direction:column;height:100%;padding:14px">
         <div style="display:flex;align-items:center;gap:8px">${mark}</div>
         <div style="margin-top:auto">${copy}</div>
         <div style="margin-top:10px">${cta}</div>
       </div>`;

  return `<!doctype html><html><head><meta charset="utf-8"><style>
    *{box-sizing:border-box;margin:0;padding:0}
    html,body{width:${unit.width}px;height:${unit.height}px;overflow:hidden}
    body{background:${bgColor};font-family:${fontFamily};
      /* Text rendering is pinned so a frame captured now matches one captured
         on a differently-configured container. */
      -webkit-font-smoothing:antialiased;text-rendering:geometricPrecision}
    #unit{position:relative;width:${unit.width}px;height:${unit.height}px;overflow:hidden;
      border:1px solid ${accentColor}33}
    /* The accent wash keeps the middle of a flat unit from reading as a dead
       block, and it is what the drift moves. */
    #wash{position:absolute;inset:0;z-index:0;
      background:radial-gradient(120% 140% at 12% 0%, ${accentColor}22, transparent 60%)}
    /* A single specular pass. Cheap in GIF terms because it is the same few
       palette entries moving, not new colour. */
    #sweep{position:absolute;top:0;bottom:0;width:38%;z-index:1;pointer-events:none;
      background:linear-gradient(100deg, transparent, ${accentColor}1f 45%, transparent);
      transform:translateX(-120%)}
    .stage{position:relative;z-index:2}
    #domain{position:absolute;right:6px;bottom:4px;z-index:3;font-size:9px;letter-spacing:.06em;
      color:${fgColor};opacity:.45}
  </style></head><body>
    <div id="unit">
      <div id="wash"></div>
      <div id="sweep"></div>
      ${inner}
      ${unit.row ? "" : `<div id="domain">${escapeHtml(domain)}</div>`}
    </div>
  <script>
  var GIF_FPS = ${GIF_FPS};
  var T = ${JSON.stringify(GIF_TIMELINE)};
  var REDUCED = ${reducedMotion ? "true" : "false"};
  function easeOut(t){var c=Math.min(1,Math.max(0,t));return 1-Math.pow(1-c,3);}
  function phase(ms,a,b){if(b<=a)return ms>=b?1:0;return Math.min(1,Math.max(0,(ms-a)/(b-a)));}
  function state(frame){
    var timeMs=(frame/GIF_FPS)*1000;
    if(REDUCED)return{timeMs:timeMs,entrance:1,drift:0,cta:1,sweep:2};
    return{
      timeMs:timeMs,
      entrance:easeOut(phase(timeMs,0,T.entranceEndMs)),
      drift:phase(timeMs,T.entranceEndMs,T.holdEndMs),
      cta:easeOut(phase(timeMs,T.holdEndMs,T.endMs)),
      sweep:-1+3*phase(timeMs,T.entranceEndMs,T.holdEndMs)
    };
  }
  // Drive every animated value from the frame index. No CSS transitions or
  // animations anywhere: they run on their own clock and would desynchronise
  // from the capture.
  window.__seek = function (frame) {
    var s = state(frame);
    var copy = document.getElementById('copy');
    var mark = document.getElementById('mark');
    var cta = document.getElementById('cta');
    var sweep = document.getElementById('sweep');
    var wash = document.getElementById('wash');

    // Entrance: copy rises a few pixels into place and fades up. Small, because
    // a banner is read in a glance and a long entrance wastes most of the loop.
    var rise = (1 - s.entrance) * 6;
    copy.style.transform = 'translateY(' + rise.toFixed(2) + 'px)';
    copy.style.opacity = (0.15 + 0.85 * s.entrance).toFixed(3);
    mark.style.opacity = (0.3 + 0.7 * s.entrance).toFixed(3);

    // Hold: the wash drifts slowly so the unit is never completely static,
    // which is the whole reason an animated banner outperforms a flat one.
    wash.style.transform = 'translateX(' + (s.drift * 4).toFixed(2) + 'px)';
    sweep.style.transform = 'translateX(' + (s.sweep * 120).toFixed(2) + '%)';

    // Final beat: the CTA lifts slightly and reaches full strength. It ends the
    // loop at rest, so the wrap back to frame 0 is not a visible snap.
    var lift = 1 + 0.04 * s.cta;
    cta.style.transform = 'scale(' + lift.toFixed(3) + ')';
    cta.style.opacity = (0.82 + 0.18 * Math.max(s.entrance, s.cta)).toFixed(3);
  };
  window.__seek(0);
  </script></body></html>`;
}
