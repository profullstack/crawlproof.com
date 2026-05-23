// Drop-in stats tracker served at https://crawlproof.com/stats.js.
// Customers paste:
//   <script data-site="<project_id>" src="https://crawlproof.com/stats.js"></script>
// We deliberately keep this tiny, dependency-free, and best-effort — failures
// must never break the host page.

import { env } from "@/lib/env";

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
    function enc(v) { return encodeURIComponent(v == null ? '' : String(v)); }
    function pageUrl() { return location.origin + location.pathname + location.search; }
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
        var url = endpoint
          + '?site=' + enc(siteId)
          + '&event=' + enc(eventName || 'pageview')
          + '&url=' + enc(pageUrl())
          + '&ref=' + enc(document.referrer || '')
          + '&target=' + enc(target || '')
          + '&t=' + enc(Date.now());
        fetch(url, {
          method: 'GET',
          keepalive: true,
          credentials: 'omit',
          mode: 'no-cors',
          cache: 'no-store'
        }).catch(function(){});
      } catch (_) {}
    }
    window.crawlproof = window.crawlproof || {};
    window.crawlproof.track = function(name, target) { send(name || 'custom', target || ''); };

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
