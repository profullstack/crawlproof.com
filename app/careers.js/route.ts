// Careers widget served at https://crawlproof.com/careers.js.
//
// Customers never paste this tag themselves — /stats.js lazy-loads it once the
// project has the careers module enabled AND the current page looks like a
// careers page. Mounting rules, in order of preference:
//
//   <div data-cp-careers></div>   explicit container, anywhere on the page
//   #careers                      common existing anchor
//   <main> / <body>               auto-vivify (the "drop in one script" path)
//
// Two hard rules, same as ad.js and stats.js: no dependencies, and any failure
// leaves the host page exactly as it was.
//
// It also writes a schema.org JobPosting graph into the host page. A
// client-rendered job board is invisible to crawlers otherwise — the precise
// failure CrawlProof audits for — so the JSON-LD is not optional decoration.

import { env } from "@/lib/env";

const snippet = `(function(){
  try {
    var ORIGIN = ${JSON.stringify(env.siteUrl)};
    var cfg = window.__crawlproofCareers || {};
    var siteId = cfg.site;
    if (!siteId) {
      // Direct <script src=".../careers.js" data-site="…"> also works, for
      // people who want the board without the tracker's auto-detection.
      var s = document.currentScript;
      if (!s) {
        var all = document.getElementsByTagName('script');
        for (var i = all.length - 1; i >= 0; i--) {
          if (all[i].src && all[i].src.indexOf('/careers.js') !== -1) { s = all[i]; break; }
        }
      }
      siteId = s && s.dataset && s.dataset.site;
    }
    if (!siteId) return;
    if (window.__crawlproofCareersMounted) return;
    window.__crawlproofCareersMounted = true;

    function esc(v) {
      return String(v == null ? '' : v)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    function safeUrl(v) {
      if (!v) return '';
      var t = String(v).trim();
      return /^https?:\\/\\//i.test(t) ? t : '';
    }

    // Mirrors workplaceSummary() on the server: a bare city already reads as
    // on-site, so only remote and hybrid get labelled.
    function workplaceText(j) {
      var place = (j.location || '').trim();
      if (j.workplace === 'remote') return place ? 'Remote \\u00b7 ' + place : 'Remote';
      if (j.workplace === 'hybrid') return place ? 'Hybrid \\u00b7 ' + place : 'Hybrid';
      return place || 'On-site';
    }

    function mountPoint() {
      return document.querySelector('[data-cp-careers]')
        || document.getElementById('careers')
        || document.querySelector('main')
        || document.body;
    }

    var STYLE = [
      '.cp-careers{--cp-gap:16px;font:inherit;color:inherit;max-width:960px;margin:0 auto;padding:8px 0}',
      '.cp-careers *{box-sizing:border-box}',
      '.cp-careers-filters{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:var(--cp-gap)}',
      '.cp-careers-filters input,.cp-careers-filters select{flex:1 1 180px;min-width:0;padding:8px 10px;border:1px solid currentColor;border-radius:8px;background:transparent;color:inherit;font:inherit;opacity:.9}',
      '.cp-careers-count{font-size:.85em;opacity:.7;margin-bottom:8px}',
      '.cp-careers-job{border:1px solid currentColor;border-radius:10px;margin-bottom:10px;overflow:hidden}',
      '.cp-careers-head{width:100%;display:flex;flex-wrap:wrap;align-items:baseline;gap:8px;padding:14px 16px;background:transparent;border:0;color:inherit;font:inherit;text-align:left;cursor:pointer}',
      '.cp-careers-title{font-weight:600;flex:1 1 auto}',
      '.cp-careers-meta{font-size:.85em;opacity:.7}',
      '.cp-careers-body{padding:0 16px 16px;display:none}',
      '.cp-careers-job[data-open="1"] .cp-careers-body{display:block}',
      '.cp-careers-body h4{margin:14px 0 6px;font-size:.95em}',
      '.cp-careers-body ul{margin:0;padding-left:20px}',
      '.cp-careers-body li{margin:3px 0}',
      '.cp-careers-form{display:grid;gap:10px;margin-top:16px;padding-top:14px;border-top:1px solid currentColor}',
      '.cp-careers-form label{display:grid;gap:4px;font-size:.85em;opacity:.85}',
      '.cp-careers-form input{padding:9px 11px;border:1px solid currentColor;border-radius:8px;background:transparent;color:inherit;font:inherit}',
      '.cp-careers-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
      '.cp-careers-submit{padding:9px 16px;border-radius:8px;border:1px solid currentColor;background:transparent;color:inherit;font:inherit;font-weight:600;cursor:pointer}',
      '.cp-careers-submit[disabled]{opacity:.5;cursor:default}',
      '.cp-careers-msg{font-size:.85em}',
      '.cp-careers-empty{padding:20px 0;opacity:.7}',
      '.cp-careers-credit{margin-top:14px;font-size:.75em;opacity:.55}',
      '.cp-careers-credit a{color:inherit}'
    ].join('');

    function injectStyle() {
      if (document.getElementById('cp-careers-style')) return;
      var el = document.createElement('style');
      el.id = 'cp-careers-style';
      el.textContent = STYLE;
      document.head.appendChild(el);
    }

    // schema.org graph for every open role, written once. Crawlers read this
    // even though the cards themselves are painted by script.
    function injectJsonLd(payload) {
      try {
        if (!payload.jobs.length) return;
        if (document.getElementById('cp-careers-jsonld')) return;
        var org = payload.org || {};
        var graph = payload.jobs.map(function(j){
          var desc = [j.overview || '',
            j.responsibilities && j.responsibilities.length ? 'Key Responsibilities: ' + j.responsibilities.join('; ') : '',
            j.qualifications && j.qualifications.length ? 'Minimum Qualifications: ' + j.qualifications.join('; ') : ''
          ].filter(Boolean).join('\\n\\n') || j.title;
          var node = {
            '@type': 'JobPosting',
            title: j.title,
            description: desc,
            employmentType: j.employment_type_schema || undefined,
            datePosted: j.published_at || undefined,
            hiringOrganization: { '@type': 'Organization', name: org.name || location.hostname, sameAs: org.url || location.origin },
            directApply: !j.apply_url,
            url: location.origin + location.pathname + '#cp-job-' + j.slug,
            sameAs: j.canonical_url || undefined
          };
          var place = j.location ? { '@type': 'Place', address: { '@type': 'PostalAddress', addressLocality: j.location } } : null;
          if (j.workplace === 'remote') {
            node.jobLocationType = 'TELECOMMUTE';
            if (j.location) node.applicantLocationRequirements = { '@type': 'Country', name: j.location };
          } else if (j.workplace === 'hybrid') {
            node.jobLocationType = 'TELECOMMUTE';
            if (place) node.jobLocation = place;
          } else if (place) {
            node.jobLocation = place;
          }
          if (j.department) node.occupationalCategory = j.department;
          return node;
        });
        var tag = document.createElement('script');
        tag.type = 'application/ld+json';
        tag.id = 'cp-careers-jsonld';
        tag.textContent = JSON.stringify({ '@context': 'https://schema.org', '@graph': graph });
        document.head.appendChild(tag);
      } catch (_) {}
    }

    function jobCard(j) {
      var meta = [j.department, workplaceText(j), j.employment_type, j.compensation]
        .filter(Boolean).map(esc).join(' &middot; ');
      var html = '<div class="cp-careers-job" id="cp-job-' + esc(j.slug) + '" data-id="' + esc(j.id) + '" data-open="0">';
      html += '<button type="button" class="cp-careers-head" aria-expanded="false">';
      html += '<span class="cp-careers-title">' + esc(j.title) + '</span>';
      html += '<span class="cp-careers-meta">' + meta + '</span>';
      html += '</button><div class="cp-careers-body">';
      if (j.overview) html += '<p>' + esc(j.overview).replace(/\\n+/g, '</p><p>') + '</p>';
      if (j.responsibilities && j.responsibilities.length) {
        html += '<h4>Key Responsibilities</h4><ul>' + j.responsibilities.map(function(r){ return '<li>' + esc(r) + '</li>'; }).join('') + '</ul>';
      }
      if (j.qualifications && j.qualifications.length) {
        html += '<h4>Minimum Qualifications</h4><ul>' + j.qualifications.map(function(r){ return '<li>' + esc(r) + '</li>'; }).join('') + '</ul>';
      }
      var external = safeUrl(j.apply_url);
      if (external) {
        html += '<p style="margin-top:16px"><a class="cp-careers-submit" style="display:inline-block;text-decoration:none" href="' + esc(external) + '" target="_blank" rel="noopener noreferrer">Apply for this role</a></p>';
      } else {
        html += '<form class="cp-careers-form" novalidate>';
        html += '<label>Full Name<input name="fullName" type="text" required maxlength="200" placeholder="Jane Doe" autocomplete="name"></label>';
        html += '<label>Email Address<input name="email" type="email" required maxlength="254" placeholder="jane@example.com" autocomplete="email"></label>';
        html += '<label>Portfolio / LinkedIn / GitHub<input name="link" type="url" maxlength="500" placeholder="https://github.com/username" autocomplete="url"></label>';
        html += '<div class="cp-careers-actions"><button type="submit" class="cp-careers-submit">Submit application</button><span class="cp-careers-msg" role="status"></span></div>';
        html += '</form>';
      }
      html += '</div></div>';
      return html;
    }

    function render(root, payload) {
      var jobs = payload.jobs;
      var departments = [];
      for (var i = 0; i < jobs.length; i++) {
        var d = jobs[i].department;
        if (d && departments.indexOf(d) === -1) departments.push(d);
      }

      var wrap = document.createElement('div');
      wrap.className = 'cp-careers';
      var filters = departments.length || jobs.length > 3
        ? '<div class="cp-careers-filters">'
          + '<input type="search" class="cp-f-q" placeholder="Title or keyword" aria-label="Search roles">'
          + '<input type="search" class="cp-f-loc" placeholder="Remote or city" aria-label="Filter by location">'
          + (departments.length ? '<select class="cp-f-dept" aria-label="Filter by department"><option value="">All departments</option>'
              + departments.map(function(d){ return '<option value="' + esc(d) + '">' + esc(d) + '</option>'; }).join('')
              + '</select>' : '')
          + '</div>'
        : '';
      wrap.innerHTML = filters
        + '<p class="cp-careers-count"></p>'
        + '<div class="cp-careers-list"></div>'
        + '<p class="cp-careers-credit">Job board by <a href="' + ORIGIN + '" target="_blank" rel="noopener noreferrer">CrawlProof</a></p>';

      var list = wrap.querySelector('.cp-careers-list');
      var count = wrap.querySelector('.cp-careers-count');
      var fq = wrap.querySelector('.cp-f-q');
      var floc = wrap.querySelector('.cp-f-loc');
      var fdept = wrap.querySelector('.cp-f-dept');

      function matches(j) {
        var q = fq && fq.value.trim().toLowerCase();
        var loc = floc && floc.value.trim().toLowerCase();
        var dept = fdept && fdept.value;
        if (q && (j.title + ' ' + (j.overview || '')).toLowerCase().indexOf(q) === -1) return false;
        if (loc) {
          var hay = (j.workplace + ' ' + (j.location || '')).toLowerCase();
          if (hay.indexOf(loc) === -1) return false;
        }
        if (dept && j.department !== dept) return false;
        return true;
      }

      function paint() {
        var shown = jobs.filter(matches);
        count.textContent = shown.length === 1 ? '1 open role' : shown.length + ' open roles';
        list.innerHTML = shown.length
          ? shown.map(jobCard).join('')
          : '<p class="cp-careers-empty">No roles match those filters.</p>';
        openFromHash();
      }

      function openFromHash() {
        var h = location.hash;
        if (!h || h.indexOf('#cp-job-') !== 0) return;
        var el = document.getElementById(h.slice(1));
        if (!el) return;
        el.setAttribute('data-open', '1');
        var head = el.querySelector('.cp-careers-head');
        if (head) head.setAttribute('aria-expanded', 'true');
      }

      if (fq) fq.addEventListener('input', paint);
      if (floc) floc.addEventListener('input', paint);
      if (fdept) fdept.addEventListener('change', paint);

      list.addEventListener('click', function(e) {
        var head = e.target.closest && e.target.closest('.cp-careers-head');
        if (!head) return;
        var card = head.parentNode;
        var open = card.getAttribute('data-open') === '1' ? '0' : '1';
        card.setAttribute('data-open', open);
        head.setAttribute('aria-expanded', open === '1' ? 'true' : 'false');
      });

      list.addEventListener('submit', function(e) {
        var form = e.target;
        if (!form.classList || !form.classList.contains('cp-careers-form')) return;
        e.preventDefault();
        var card = form.closest('.cp-careers-job');
        var msg = form.querySelector('.cp-careers-msg');
        var btn = form.querySelector('.cp-careers-submit');
        var payloadBody = {
          site: siteId,
          job: card.getAttribute('data-id'),
          fullName: form.fullName.value,
          email: form.email.value,
          link: form.link.value,
          url: location.origin + location.pathname
        };
        if (!payloadBody.fullName.trim()) { msg.textContent = 'Enter your name.'; return; }
        if (!payloadBody.email.trim()) { msg.textContent = 'Enter your email.'; return; }

        btn.disabled = true;
        msg.textContent = 'Sending…';
        fetch(ORIGIN + '/api/careers/apply', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payloadBody)
        }).then(function(r){ return r.json().catch(function(){ return { ok: r.ok }; }); })
          .then(function(res){
            if (res && res.ok) {
              form.innerHTML = '<p class="cp-careers-msg">Application received. We\\'ll be in touch.</p>';
            } else {
              btn.disabled = false;
              msg.textContent = (res && res.error) || 'Could not submit. Try again.';
            }
          })
          .catch(function(){
            btn.disabled = false;
            msg.textContent = 'Could not submit. Try again.';
          });
      });

      root.appendChild(wrap);
      paint();
      window.addEventListener('hashchange', openFromHash);
    }

    function boot() {
      fetch(ORIGIN + '/api/careers/jobs?site=' + encodeURIComponent(siteId), { credentials: 'omit' })
        .then(function(r){ return r.json(); })
        .then(function(payload){
          if (!payload || !payload.jobs) return;
          injectJsonLd(payload);
          if (!payload.jobs.length) return;
          injectStyle();
          var root = mountPoint();
          if (root) render(root, payload);
        })
        .catch(function(){});
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', boot);
    } else {
      boot();
    }
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
