// Measuring an in-banner video, which is a different thing from a pre-roll.
//
// A pre-roll is something a listener waits through: it starts because they
// asked for content, it plays once, and "complete" means they sat through it.
// An in-banner video is muted, autoplaying and LOOPING inside somebody else's
// page, and every one of those differences would corrupt the same numbers if
// they were measured the same way:
//
//   * It loops, so only the FIRST loop is counted. A unit left on screen for
//     three minutes would otherwise report thirty-odd completions and a
//     completion rate over 100%, which this network has already been bitten by
//     once on impressions.
//   * It autoplays below the fold, so a `start` requires the unit to be at
//     least half visible. A muted video playing where nobody can see it is not
//     a view, and counting it as one makes the whole funnel a measure of how
//     much inventory is off-screen.
//   * Nobody chose to watch it, so `abandon` is not a signal of rejection the
//     way it is for a pre-roll. It is recorded, but it means "the page went
//     away", not "the viewer bailed".
//
// Delivered as an inline script in OUR document — the /api/ads/frame path,
// which is a real cross-origin page with its own CSP. It deliberately does not
// go into the ad.js srcdoc unit: that iframe is sandboxed without
// `allow-scripts`, so nothing here would run, and granting scripts to
// advertiser-derived markup to collect a statistic is not a trade worth making.

/** Events reported through the pixel, in the order a full play produces them. */
export const BANNER_EVENTS = [
  "asset_requested",
  "start",
  "first_quartile",
  "midpoint",
  "third_quartile",
  "complete",
] as const;

/**
 * The inline measurement script for a banner document.
 *
 * Beacons are image requests, not fetches. This document's own CSP would allow
 * either, but the pixel is what also works if the same markup is ever rendered
 * somewhere governed by a publisher's policy, and one code path that works
 * everywhere beats two that each work somewhere.
 */
export function bannerBeaconScript(decisionId: string, origin: string): string {
  const endpoint = `${origin.replace(/\/$/, "")}/api/ads/video/events`;
  return `<script>(function(){
  try {
    var D = ${JSON.stringify(decisionId)};
    var E = ${JSON.stringify(endpoint)};
    var v = document.querySelector('video, audio');
    if (!v) return;
    var sent = {};
    function beacon(t, extra) {
      if (sent[t]) return;
      sent[t] = 1;
      try {
        var q = E + '?d=' + encodeURIComponent(D) + '&t=' + encodeURIComponent(t);
        if (extra && extra.m != null) q += '&m=' + Math.round(extra.m);
        if (extra && extra.p != null) q += '&p=' + Math.round(extra.p);
        if (extra && extra.e) q += '&e=' + encodeURIComponent(extra.e);
        new Image().src = q;
      } catch (_) {}
    }

    beacon('asset_requested');

    // Half the unit on screen, which is the line the rest of the industry
    // draws too. Without IntersectionObserver we assume visible rather than
    // assume hidden: the fallback should under-report nothing it can see.
    var visible = true;
    try {
      if (window.IntersectionObserver) {
        visible = false;
        new IntersectionObserver(function(entries){
          for (var i = 0; i < entries.length; i++) visible = entries[i].intersectionRatio >= 0.5;
        }, { threshold: [0, 0.5, 1] }).observe(v);
      }
    } catch (_) {}

    // The first loop only. currentTime resets to 0 when it wraps, so the wrap
    // is detectable without waiting for 'ended' — which a looping element
    // never fires at all.
    var done = false, last = 0, started = 0, playedMs = 0, tick = 0;
    function progress() {
      if (done) return;
      var now = Date.now();
      if (started && tick && !v.paused) playedMs += Math.min(now - tick, 2000);
      tick = now;

      var t = v.currentTime || 0;
      var dur = v.duration;
      if (!dur || !isFinite(dur) || dur <= 0) { last = t; return; }

      if (!started && visible && !v.paused) {
        started = now;
        beacon('start', { m: 0, p: 0 });
      }
      if (!started) { last = t; return; }

      // Wrapped: the first loop finished.
      if (t + 0.25 < last) {
        beacon('complete', { m: Math.round(dur * 1000), p: playedMs });
        done = true;
        return;
      }
      last = t;

      var pct = t / dur;
      if (pct >= 0.25) beacon('first_quartile', { m: t * 1000, p: playedMs });
      if (pct >= 0.5) beacon('midpoint', { m: t * 1000, p: playedMs });
      if (pct >= 0.75) beacon('third_quartile', { m: t * 1000, p: playedMs });
    }

    v.addEventListener('timeupdate', progress);
    v.addEventListener('ended', function(){
      if (done) return;
      beacon('complete', { m: (v.duration || 0) * 1000, p: playedMs });
      done = true;
    });
    v.addEventListener('error', function(){
      beacon('error', { e: (v.error && v.error.code) ? ('media_' + v.error.code) : 'media_error' });
    });

    // The page going away before the first loop finished. Not a rejection —
    // nobody chose to start this — but it is the difference between a unit
    // that played through and one that was scrolled past.
    window.addEventListener('pagehide', function(){
      if (done || !started) return;
      beacon('abandon', { m: (v.currentTime || 0) * 1000, p: playedMs });
    });
  } catch (_) {}
})();</script>`;
}

/**
 * Put the script in the document.
 *
 * Before `</body>` so the media element exists when it runs, and appended
 * rather than templated into the renderer: the creative renderers in
 * lib/ads/creative.ts are pure and client-safe, and a decision id is neither.
 */
export function injectBannerBeacon(html: string, script: string): string {
  if (!html.includes("</body>")) return html + script;
  return html.replace("</body>", `${script}</body>`);
}
