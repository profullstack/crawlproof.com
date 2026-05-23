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
    function send() {
      var body = JSON.stringify({
        site: siteId,
        ref: document.referrer || null,
        path: location.pathname + location.search,
      });
      try {
        fetch(endpoint, {
          method: 'POST',
          keepalive: true,
          headers: { 'Content-Type': 'application/json' },
          body: body,
          credentials: 'omit',
          mode: 'no-cors'
        }).catch(function(){});
      } catch (_) {}
    }
    if (document.readyState === 'complete') send();
    else window.addEventListener('load', send, { once: true });
    // SPA: re-emit on history changes.
    var lastPath = location.pathname + location.search;
    function onNav() {
      var p = location.pathname + location.search;
      if (p === lastPath) return;
      lastPath = p;
      send();
    }
    var ps = history.pushState;
    history.pushState = function(){ ps.apply(this, arguments); onNav(); };
    var rs = history.replaceState;
    history.replaceState = function(){ rs.apply(this, arguments); onNav(); };
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
