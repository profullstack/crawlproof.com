// Drop-in stats tracker served at https://crawlproof.com/stats.js.
// Customers paste:
//   <script data-site="<project_id>" src="https://crawlproof.com/stats.js"></script>
// We deliberately keep this tiny, dependency-free, and best-effort — failures
// must never break the host page.

import { env } from "@/lib/env";
import { VISITOR_SNIPPET } from "@/lib/tracker/visitorSnippet";

const snippet = `(function(){
  try {
    var s = document.currentScript;
    if (!s) {
      var scripts = document.getElementsByTagName('script');
      for (var i = scripts.length - 1; i >= 0; i--) {
        if (scripts[i].src && scripts[i].src.indexOf('/stats.js') !== -1) { s = scripts[i]; break; }
      }
    }
    var siteId = s && s.dataset && s.dataset.site;
    if (!siteId) return;
    var endpoint = ${JSON.stringify(env.siteUrl)} + '/api/track';

    // Careers module. Opt-in per project in the dashboard, but we only pay to
    // load it on pages that look like a careers page — every other pageview
    // costs one querySelector and a string compare. /careers.js itself decides
    // whether the project actually has the module on.
    // Opt out entirely with data-careers="off"; point it elsewhere with
    // data-careers-path="/jobs".
    (function(){
      try {
        if (s.dataset.careers === 'off') return;
        var wanted = s.dataset.careersPath || '/careers';
        function maybeLoad() {
          try {
            var path = location.pathname.replace(/\\/+$/, '') || '/';
            var target = wanted.replace(/\\/+$/, '') || '/';
            if (!document.querySelector('[data-cp-careers]') && path !== target) return;
            if (window.__crawlproofCareers) return;
            window.__crawlproofCareers = { site: siteId };
            var cs = document.createElement('script');
            cs.src = ${JSON.stringify(env.siteUrl)} + '/careers.js';
            cs.async = true;
            (document.head || document.documentElement).appendChild(cs);
          } catch (_) {}
        }
        if (document.readyState === 'loading') {
          document.addEventListener('DOMContentLoaded', maybeLoad);
        } else {
          maybeLoad();
        }
      } catch (_) {}
    })();

    function pageUrl() { return location.origin + location.pathname + location.search; }
${VISITOR_SNIPPET}
    // Session-only companion state. The visitor equivalents live in the shared
    // snippet above, which /ad.js also inlines so both agree on the same id.
    var memSession = null, memSessionTs = 0;
    // Session id with a 30-minute inactivity window, shared across tabs. The
    // window slides on every event, so an active visit stays one session and
    // reopening within 30 min reuses it instead of minting a new one.
    var SESSION_TTL = 1800000; // 30 min
    function getSessionId() {
      var k = 'crawlproof.session', now = Date.now();
      var raw = lsGet(k);
      if (raw) {
        var sep = raw.lastIndexOf('|');
        if (sep > 0) {
          var id = raw.slice(0, sep);
          var ts = parseInt(raw.slice(sep + 1), 10) || 0;
          if (id && (now - ts) < SESSION_TTL) { lsSet(k, id + '|' + now); return id; }
        }
      }
      if (memSession && (now - memSessionTs) < SESSION_TTL) {
        memSessionTs = now; lsSet(k, memSession + '|' + now); return memSession;
      }
      var fresh = uuid('s');
      memSession = fresh; memSessionTs = now;
      lsSet(k, fresh + '|' + now);
      return fresh;
    }
    var visitorId = getVisitorId();
    function labelFor(el) {
      try {
        return el.getAttribute('data-cp-label')
          || el.getAttribute('aria-label')
          || el.getAttribute('title')
          || el.getAttribute('id')
          || (el.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 120)
          || el.tagName.toLowerCase();
      } catch (_) {
        return '';
      }
    }
    function send(eventName, target) {
      try {
        var payload = {
          websiteId: siteId,
          site: siteId,
          domain: location.hostname,
          href: pageUrl(),
          referrer: document.referrer || null,
          viewport: {
            width: Math.max(0, window.innerWidth || 0),
            height: Math.max(0, window.innerHeight || 0)
          },
          visitorId: visitorId,
          sessionId: getSessionId(),
          language: navigator.language || '',
          timezone: (window.Intl && Intl.DateTimeFormat) ? Intl.DateTimeFormat().resolvedOptions().timeZone : '',
          screenWidth: screen && screen.width ? screen.width : 0,
          screenHeight: screen && screen.height ? screen.height : 0,
          type: eventName || 'pageview',
          target: target || ''
        };
        fetch(endpoint, {
          method: 'POST',
          keepalive: true,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          credentials: 'omit',
          mode: 'cors',
          cache: 'no-store'
        }).catch(function(){});
      } catch (_) {}
    }
    function cpTrack(name, arg) {
      // Custom behavioral event with an optional string "target" label.
      send(name || 'custom', typeof arg === 'string' ? arg : '');
    }
    // Callable API so the async stub pattern works:
    //   window.crawlproof('track', 'signup_click')
    // plus method form: window.crawlproof.track('signup_click').
    var prev = window.crawlproof;
    function api(method) {
      var args = Array.prototype.slice.call(arguments, 1);
      try {
        if (method === 'track') return cpTrack(args[0], args[1]);
        return cpTrack(method, args[0]);
      } catch (_) {}
    }
    api.track = cpTrack;
    window.crawlproof = api;
    // Drain calls queued before the script loaded.
    try {
      var queued = prev && prev.q;
      if (queued && queued.length) {
        for (var qi = 0; qi < queued.length; qi++) api.apply(null, queued[qi]);
      }
    } catch (_) {}

    if (document.readyState === 'complete') send('pageview');
    else window.addEventListener('load', function(){ send('pageview'); }, { once: true });

    document.addEventListener('click', function(e) {
      try {
        var el = e.target && e.target.closest && e.target.closest('a,button,input[type="button"],input[type="submit"],[role="button"],[data-track],[data-cp-track]');
        if (!el) return;
        var name = el.getAttribute('data-cp-track') || el.getAttribute('data-track');
        if (name) { send(name, labelFor(el)); return; }
        if (el.tagName === 'A') {
          var href = el.getAttribute('href') || '';
          if (!href || href.charAt(0) === '#') return;
          var a = new URL(href, location.href);
          if (el.hasAttribute('download') || /\\.(pdf|zip|csv|xlsx?|docx?|pptx?|mp[34]|mov|avi|dmg|pkg|exe)$/i.test(a.pathname)) send('download_click', a.pathname);
          else if (a.hostname && a.hostname !== location.hostname) send('outbound_click', a.hostname + a.pathname);
          else send('internal_click', a.pathname || labelFor(el));
          return;
        }
        send('button_click', labelFor(el));
      } catch (_) {}
    }, true);

    document.addEventListener('submit', function(e){
      var form = e.target;
      send('form_submit', form && (form.getAttribute('name') || form.getAttribute('id') || form.getAttribute('action') || 'form'));
    }, true);

    var scrollMarks = {};
    function onScroll() {
      try {
        var doc = document.documentElement;
        var max = Math.max(1, doc.scrollHeight - innerHeight);
        var pct = Math.floor((scrollY / max) * 100);
        var marks = [25, 50, 75, 100];
        for (var i = 0; i < marks.length; i++) {
          if (pct >= marks[i] && !scrollMarks[marks[i]]) {
            scrollMarks[marks[i]] = true;
            send('scroll_' + marks[i]);
          }
        }
      } catch (_) {}
    }
    window.addEventListener('scroll', onScroll, { passive: true });

    // SPA: re-emit on history changes.
    var lastPath = location.pathname + location.search;
    function onNav() {
      var p = location.pathname + location.search;
      if (p === lastPath) return;
      lastPath = p;
      scrollMarks = {};
      send('pageview');
    }
    var ps = history.pushState;
    history.pushState = function(){ var r = ps.apply(this, arguments); onNav(); return r; };
    var rs = history.replaceState;
    history.replaceState = function(){ var r = rs.apply(this, arguments); onNav(); return r; };
    window.addEventListener('popstate', onNav);
  } catch (_) {}
})();`;

export async function GET() {
  return new Response(snippet, {
    headers: {
      "content-type": "application/javascript; charset=utf-8",
      // Short cache so we can ship snippet fixes quickly; CDN can still front it.
      "cache-control": "public, max-age=300, s-maxage=300",
      "access-control-allow-origin": "*",
    },
  });
}
