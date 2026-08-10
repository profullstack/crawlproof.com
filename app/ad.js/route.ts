// Drop-in ad unit served at https://crawlproof.com/ad.js.
// Publishers paste, once per slot:
//   <div data-cp-ad data-slot="<slot_id>" data-format="banner_300x250"></div>
//   <script src="https://crawlproof.com/ad.js" async></script>
// Each container is filled with an isolated iframe. Best-effort — any failure
// leaves the container empty and never breaks the host page.

import { env } from "@/lib/env";
import { VISITOR_SNIPPET } from "@/lib/tracker/visitorSnippet";

const FORMATS = {
  banner_300x250: [300, 250],
  banner_728x90: [728, 90],
  banner_320x50: [320, 50],
  text_link: [600, 40],
} as const;

const snippet = `(function(){
  try {
    var ORIGIN = ${JSON.stringify(env.siteUrl)};
    var SIZES = ${JSON.stringify(FORMATS)};
${VISITOR_SNIPPET}
    function pickFormat(el, w) {
      var f = el.getAttribute('data-format');
      if (f && SIZES[f]) return f;
      // Choose by available width when unspecified.
      if (w >= 728) return 'banner_728x90';
      if (w >= 300) return 'banner_300x250';
      return 'banner_320x50';
    }
    function fill(el) {
      if (el.getAttribute('data-cp-filled')) return;
      var slot = el.getAttribute('data-slot');
      if (!slot) return;
      var w = el.clientWidth || el.offsetWidth || 300;
      var format = pickFormat(el, w);
      var dims = SIZES[format] || SIZES.banner_300x250;
      var q = '?slot=' + encodeURIComponent(slot) + '&format=' + encodeURIComponent(format);
      // Mints the id if this is the first CrawlProof script on the page. It
      // used to only read one stats.js had already written, so an ad-tag-only
      // publisher reported every impression as an anonymous visitor.
      var v = getVisitorId();
      if (v) q += '&v=' + encodeURIComponent(v);
      el.setAttribute('data-cp-filled', '1');
      fetch(ORIGIN + '/api/ads/serve' + q, { mode: 'cors', credentials: 'omit', cache: 'no-store' })
        .then(function(r){ return r.json(); })
        .then(function(res){
          if (!res || !res.ok || !res.html) { el.removeAttribute('data-cp-filled'); return; }
          var iframe = document.createElement('iframe');
          iframe.setAttribute('title', 'Advertisement');
          iframe.setAttribute('scrolling', 'no');
          iframe.setAttribute('frameborder', '0');
          iframe.setAttribute('loading', 'lazy');
          // Sandbox: allow the ad's click link to open a new tab, nothing else.
          iframe.setAttribute('sandbox', 'allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation');
          iframe.style.border = '0';
          // Text links are native full-width; banners keep their fixed box.
          iframe.style.width = (format === 'text_link') ? '100%' : (dims[0] + 'px');
          iframe.style.height = dims[1] + 'px';
          iframe.style.maxWidth = '100%';
          iframe.style.display = 'block';
          iframe.srcdoc = res.html;
          el.innerHTML = '';
          // A subtle disclosure label above the unit, linking back to
          // CrawlProof. Skipped for the native text link, which already carries
          // its own 'Sponsored' mark. Muted + no underline so it stays quiet on
          // any host page.
          if (format !== 'text_link') {
            var cap = document.createElement('a');
            cap.href = ORIGIN + '/?utm_source=ad-label&utm_medium=ad&utm_campaign=advertisement';
            cap.target = '_blank';
            cap.rel = 'noopener sponsored';
            cap.textContent = 'Advertisement';
            cap.style.cssText = 'display:block;margin:0 0 3px;font:600 9px/1.3 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;letter-spacing:.1em;text-transform:uppercase;color:#8a94a3;text-decoration:none;opacity:.75';
            el.appendChild(cap);
          }
          el.appendChild(iframe);
        })
        .catch(function(){ el.removeAttribute('data-cp-filled'); });
    }
    function scan() {
      var nodes = document.querySelectorAll('[data-cp-ad]');
      for (var i = 0; i < nodes.length; i++) fill(nodes[i]);
    }
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', scan, { once: true });
    } else {
      scan();
    }
    // Expose a manual trigger for SPA/late-inserted slots.
    window.crawlproofAds = { scan: scan };
  } catch (_) {}
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
