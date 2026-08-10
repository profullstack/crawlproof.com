// Browser-side visitor identity, shared verbatim by /stats.js and /ad.js.
//
// One definition, two consumers. These two scripts have to agree on the
// visitor id or the ad network can't tie an impression back to the same person
// the stats dashboard counted — and they used to disagree in the worst
// possible way: stats.js minted the id, ad.js only ever *read* it. A publisher
// running the ad tag without the analytics tag therefore sent an empty visitor
// on every single impression. In production that was ~69% of ad impressions
// carrying no visitor at all, which in turn left ip_hash as the only signal
// available for click dedupe and frequency capping.
//
// Emitted as a string rather than a real module because both routes hand-serve
// dependency-free ES5 to arbitrary third-party pages. There is no bundler in
// that path, so sharing has to happen at the source level.
//
// Declares into the caller's scope: uuid(), lsGet(), lsSet(), getVisitorId().
// Callers that need their own storage helpers (stats.js builds a session id on
// top of these) can rely on all four being present.
//
// Scope note: this runs inside the *publisher's* page, so localStorage is
// partitioned to the publisher's origin — not CrawlProof's. The id is a stable
// per-site visitor identifier and deliberately cannot follow anyone across
// publishers; that would need third-party storage, which browsers no longer
// grant. Frequency capping and returning-visitor counts work per site. Cross-
// publisher reach does not, by design of the platform rather than of this code.
export const VISITOR_SNIPPET = `
    function uuid(prefix) {
      try {
        if (crypto && crypto.randomUUID) return prefix + crypto.randomUUID();
      } catch (_) {}
      return prefix + Math.random().toString(16).slice(2) + '-' + Date.now().toString(16);
    }
    function lsGet(k) { try { return localStorage.getItem(k); } catch (_) { return null; } }
    function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (_) {} }
    // In-memory fallback for when localStorage is blocked (private mode, ITP,
    // an embedded webview) so a single page load still reports one stable
    // visitor instead of a fresh id per call.
    var memVisitor = null;
    // Persistent visitor id — localStorage so it survives tab close, reload,
    // and browser restart. Deliberately not the per-tab storage API, which
    // counted every new tab as a new visitor, and deliberately not a cookie:
    // nothing here needs to ride on every HTTP request, and a cookie would be
    // sent to the publisher's own backend on every request too.
    function getVisitorId() {
      var k = 'crawlproof.visitor';
      var id = lsGet(k);
      if (id) return id;
      if (memVisitor) return memVisitor;
      id = uuid('v');
      lsSet(k, id);
      memVisitor = id;
      return id;
    }`;
