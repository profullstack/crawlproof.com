// Drop-in pre-roll player, served at https://crawlproof.com/preroll.js.
//
// Publishers paste:
//   <script src="https://crawlproof.com/preroll.js"></script>
//   <script>crawlproofPreroll({ slot: '<slot id>', kind: 'audio' }).then(play)</script>
//
// Why this exists rather than a documented beacon protocol: the measurements
// that matter are all timing against a media element — first frame, quartiles,
// completion, the abandon that happens while the tab is closing — and every
// player that reimplements them gets a slightly different definition of
// "watched". One implementation means one definition, and it means a publisher
// integrating a break writes no measurement code at all.
//
// Kept in the same shape as /stats.js: tiny, dependency-free, ES5, and
// incapable of breaking the page it is on. Every failure path resolves the
// promise as "no ad", because a listener waiting on a broken ad break is worse
// than a listener who never had one.

import { env } from "@/lib/env";

const snippet = `(function(){
  var ORIGIN = ${JSON.stringify((env.siteUrl || "https://crawlproof.com").replace(/\/$/, ""))};

  function uuid() {
    try {
      if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    } catch (_) {}
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      var r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  // One session id per listen, remembered for the tab. A remount inside the
  // same listen must not draw a second ad, and the server enforces that on the
  // session id — so losing it here would quietly undo the rule.
  function sessionId(explicit) {
    if (explicit) return explicit;
    try {
      var k = 'crawlproof.preroll.session';
      var v = sessionStorage.getItem(k);
      if (!v) { v = uuid(); sessionStorage.setItem(k, v); }
      return v;
    } catch (_) {
      return uuid();
    }
  }

  function send(url, decision, type, extra, beacon) {
    if (!decision) return;
    try {
      var ev = { type: type, ts: new Date().toISOString() };
      if (extra) for (var k in extra) if (extra.hasOwnProperty(k)) ev[k] = extra[k];
      var body = JSON.stringify({ decision: decision, events: [ev] });
      // The teardown events have to survive the page going away, and only
      // sendBeacon is guaranteed to. Everything else prefers fetch, whose
      // failure we can at least swallow deliberately.
      if (beacon && navigator.sendBeacon) {
        navigator.sendBeacon(url, new Blob([body], { type: 'text/plain;charset=UTF-8' }));
        return;
      }
      fetch(url, {
        method: 'POST',
        keepalive: true,
        headers: { 'Content-Type': 'application/json' },
        body: body,
        credentials: 'omit',
        mode: 'cors',
        cache: 'no-store'
      }).catch(function(){});
    } catch (_) {}
  }

  /**
   * Fetch a break, play it, and report what happened.
   *
   * Resolves with { played: false } when there was nothing to play, and with
   * { played: true, completed: <bool> } once the break is over. It never
   * rejects: the caller's next line is "resume the content", and that has to
   * run whether the ad worked or not.
   */
  function preroll(opts) {
    opts = opts || {};
    return new Promise(function(resolve) {
      var done = false;
      function finish(v) { if (!done) { done = true; resolve(v); } }
      // A break that never answers must not hold the content hostage.
      var guard = setTimeout(function(){ finish({ played: false, reason: 'timeout' }); }, opts.timeoutMs || 8000);

      try {
        var slot = opts.slot;
        if (!slot) { clearTimeout(guard); return finish({ played: false, reason: 'no_slot' }); }
        var kind = opts.kind === 'video' ? 'video' : 'audio';
        var session = sessionId(opts.session);
        var q = '?slot=' + encodeURIComponent(slot) +
                '&kind=' + kind +
                '&session=' + encodeURIComponent(session) +
                '&placement=' + encodeURIComponent(opts.placement || 'preroll') +
                '&surface=' + encodeURIComponent(opts.surface || 'web');

        fetch(ORIGIN + '/api/ads/stream' + q, { credentials: 'omit', mode: 'cors', cache: 'no-store' })
          .then(function(r){ return r.json(); })
          .then(function(ad) {
            clearTimeout(guard);
            if (!ad || !ad.url) return finish({ played: false, reason: 'no_ad' });

            var endpoint = ad.eventsUrl || (ORIGIN + '/api/ads/video/events');
            var decision = ad.decisionId;
            var fired = {};
            function once(type, extra) {
              if (fired[type]) return;
              fired[type] = true;
              send(endpoint, decision, type, extra, false);
            }

            once('asset_requested');

            // The publisher's own element when they pass one — a player that
            // already owns an <audio> has ducking, routing and a lock screen
            // wired to it, and a second element would bypass all of it.
            var el = opts.media;
            var owned = false;
            if (!el) {
              el = document.createElement(ad.kind === 'video' ? 'video' : 'audio');
              el.setAttribute('playsinline', '');
              el.preload = 'auto';
              owned = true;
              if (ad.kind === 'video' && ad.posterUrl) el.poster = ad.posterUrl;
              var host = opts.container || document.body;
              if (ad.kind === 'video') { el.style.width = '100%'; el.style.height = 'auto'; }
              else { el.style.display = 'none'; }
              if (host) host.appendChild(el);
            }

            var started = 0;
            var playedMs = 0;
            var last = 0;
            var marks = [
              { at: 0.25, type: 'first_quartile' },
              { at: 0.5, type: 'midpoint' },
              { at: 0.75, type: 'third_quartile' }
            ];

            function media() {
              return { mediaTimeMs: Math.round((el.currentTime || 0) * 1000), playedMs: Math.round(playedMs) };
            }

            function onPlaying() {
              if (!started) {
                started = Date.now();
                last = started;
                once('start', { mediaTimeMs: 0, playedMs: 0 });
              } else {
                last = Date.now();
              }
            }

            function onTime() {
              var now = Date.now();
              // Wall-clock between ticks, not currentTime: a seek forward is
              // not time watched, and a stall is not time watched either.
              if (started && last && !el.paused) playedMs += Math.min(now - last, 2000);
              last = now;
              var dur = el.duration || (ad.durationMs ? ad.durationMs / 1000 : 0);
              if (!dur || !isFinite(dur)) return;
              var pct = (el.currentTime || 0) / dur;
              for (var i = 0; i < marks.length; i++) {
                if (pct >= marks[i].at) once(marks[i].type, media());
              }
            }

            function cleanup() {
              try {
                el.removeEventListener('playing', onPlaying);
                el.removeEventListener('timeupdate', onTime);
                el.removeEventListener('ended', onEnded);
                el.removeEventListener('error', onError);
                el.removeEventListener('click', onClick);
                window.removeEventListener('pagehide', onLeave);
                document.removeEventListener('visibilitychange', onHide);
                if (owned && el.parentNode) el.parentNode.removeChild(el);
              } catch (_) {}
            }

            function onEnded() {
              once('complete', media());
              cleanup();
              finish({ played: true, completed: true });
            }

            function onError() {
              once('error', { errorReason: (el.error && el.error.code) ? ('media_' + el.error.code) : 'media_error' });
              cleanup();
              finish({ played: false, reason: 'error' });
            }

            function onClick() {
              send(endpoint, decision, 'click', media(), false);
              // The click URL is the metered one — it redirects through
              // /api/ads/click, which is what bills and pays. Opening it in a
              // new tab leaves the break playing rather than navigating the
              // listener away from their own content.
              if (ad.clickUrl) { try { window.open(ad.clickUrl, '_blank', 'noopener'); } catch (_) {} }
            }

            // Left before the end. Reported with sendBeacon because the page
            // may be gone before a fetch would flush.
            function onLeave() {
              if (fired.complete || done) return;
              send(endpoint, decision, 'abandon', media(), true);
              cleanup();
              finish({ played: true, completed: false });
            }

            function onHide() {
              if (document.visibilityState === 'hidden') onLeave();
            }

            el.addEventListener('playing', onPlaying);
            el.addEventListener('timeupdate', onTime);
            el.addEventListener('ended', onEnded);
            el.addEventListener('error', onError);
            el.addEventListener('click', onClick);
            window.addEventListener('pagehide', onLeave);
            document.addEventListener('visibilitychange', onHide);

            el.src = ad.url;
            var p = el.play();
            // Autoplay refused is not an error in the ad — it is a browser
            // policy — but it is a break that did not happen and the funnel
            // should say so rather than showing a fill with no start.
            if (p && p.catch) p.catch(function(){
              once('error', { errorReason: 'autoplay_blocked' });
              cleanup();
              finish({ played: false, reason: 'autoplay_blocked' });
            });
          })
          .catch(function(){
            clearTimeout(guard);
            finish({ played: false, reason: 'fetch_failed' });
          });
      } catch (_) {
        clearTimeout(guard);
        finish({ played: false, reason: 'error' });
      }
    });
  }

  window.crawlproofPreroll = preroll;
})();`;

export async function GET() {
  return new Response(snippet, {
    headers: {
      "content-type": "application/javascript; charset=utf-8",
      "cache-control": "public, max-age=300, s-maxage=300",
      "access-control-allow-origin": "*",
    },
  });
}
