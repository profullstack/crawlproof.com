import * as cheerio from "cheerio";
import type { CrawlContext, Finding } from "../types";

// Checks aligned with https://specification.website/mcp/ — covers the
// categories (Foundations, Accessibility, Well-Known URIs, Privacy,
// Resilience) not already handled by the other check modules.

export function checkSpecCompliance(ctx: CrawlContext): Finding[] {
  const home = ctx.pages[ctx.target];
  const out: Finding[] = [];
  if (!home?.rawHtml) return out;

  const $ = cheerio.load(home.rawHtml);
  const h = home.headers;

  // ─── Foundations ─────────────────────────────────────────────────────────

  // DOCTYPE — required for standards mode; its absence triggers quirks mode.
  const hasDoctype = /^\s*<!doctype\s+html/i.test(home.rawHtml);
  out.push({
    section: "Foundations",
    check_key: "spec.doctype",
    status: hasDoctype ? "pass" : "fail",
    title: hasDoctype ? "<!doctype html> declared" : "Missing <!doctype html>",
    detail: hasDoctype
      ? undefined
      : "Add <!doctype html> as the very first line. Its absence puts browsers in quirks mode.",
    priority: hasDoctype ? 5 : 2,
  });

  // Meta viewport — required for mobile rendering.
  const viewport = $("meta[name='viewport']").attr("content")?.trim();
  const viewportDisablesScaling = viewport
    ? /user-scalable\s*=\s*no/i.test(viewport) ||
      /maximum-scale\s*=\s*1(?:\b|\.0)/i.test(viewport)
    : false;
  out.push({
    section: "Foundations",
    check_key: "spec.meta_viewport",
    status: !viewport ? "fail" : viewportDisablesScaling ? "warn" : "pass",
    title: !viewport
      ? "Meta viewport missing"
      : viewportDisablesScaling
        ? "Viewport disables user scaling"
        : "Meta viewport present",
    detail: !viewport
      ? 'Add <meta name="viewport" content="width=device-width, initial-scale=1">.'
      : viewportDisablesScaling
        ? "Removing user-scalable=no or maximum-scale=1 improves accessibility for low-vision users."
        : `content="${viewport}"`,
    evidence: viewport ? { content: viewport } : undefined,
    priority: !viewport ? 2 : viewportDisablesScaling ? 3 : 5,
  });

  // Theme color — browser chrome tint; used by mobile browsers and PWA shells.
  const themeColor = $("meta[name='theme-color']").attr("content")?.trim();
  out.push({
    section: "Foundations",
    check_key: "spec.theme_color",
    status: themeColor ? "pass" : "warn",
    title: themeColor ? `Theme color set (${themeColor})` : "No theme-color meta tag",
    detail: themeColor
      ? undefined
      : 'Add <meta name="theme-color" content="#yourcolor"> to tint the browser chrome on mobile.',
    evidence: themeColor ? { color: themeColor } : undefined,
    priority: themeColor ? 5 : 4,
  });

  // Feed discovery — RSS/Atom/JSON Feed advertised via rel="alternate".
  const feedLinks = $("link[rel='alternate']")
    .filter((_, el) => {
      const type = $(el).attr("type") ?? "";
      return /application\/(rss|atom|feed)\+xml|application\/json/i.test(type);
    })
    .map((_, el) => ({ href: $(el).attr("href"), type: $(el).attr("type") }))
    .get();
  out.push({
    section: "Foundations",
    check_key: "spec.feed_discovery",
    status: feedLinks.length > 0 ? "pass" : "warn",
    title: feedLinks.length > 0 ? `${feedLinks.length} feed(s) discovered` : "No feed announced",
    detail:
      feedLinks.length > 0
        ? feedLinks.map((f) => `${f.type}: ${f.href}`).join("\n")
        : 'Add <link rel="alternate" type="application/rss+xml" href="/feed.xml"> so agents and readers can subscribe.',
    evidence: feedLinks.length > 0 ? { feeds: feedLinks } : undefined,
    priority: feedLinks.length > 0 ? 5 : 4,
  });

  // ─── Accessibility ────────────────────────────────────────────────────────

  // Skip navigation link — first focusable element to jump past repeated nav.
  const skipLinks = $("a[href]")
    .filter((_, el) => {
      const href = $(el).attr("href") ?? "";
      const text = $(el).text().toLowerCase();
      return (
        href.startsWith("#") &&
        /skip|jump|main content|content/i.test(text)
      );
    })
    .length;
  out.push({
    section: "Accessibility",
    check_key: "spec.a11y.skip_link",
    status: skipLinks > 0 ? "pass" : "warn",
    title: skipLinks > 0 ? "Skip navigation link present" : "No skip navigation link found",
    detail:
      skipLinks > 0
        ? undefined
        : 'Add a visible-on-focus skip link as the first focusable element: <a href="#main">Skip to main content</a>.',
    priority: skipLinks > 0 ? 5 : 3,
  });

  // Semantic HTML landmarks — <header>, <nav>, <main>, <footer>.
  const landmarks = {
    header: $("header").length,
    nav: $("nav").length,
    main: $("main").length,
    footer: $("footer").length,
  };
  const missingLandmarks = Object.entries(landmarks)
    .filter(([, count]) => count === 0)
    .map(([tag]) => `<${tag}>`);
  out.push({
    section: "Accessibility",
    check_key: "spec.a11y.landmarks",
    status: missingLandmarks.length === 0 ? "pass" : missingLandmarks.length <= 1 ? "warn" : "warn",
    title:
      missingLandmarks.length === 0
        ? "All semantic landmarks present (header/nav/main/footer)"
        : `Missing landmark(s): ${missingLandmarks.join(", ")}`,
    detail:
      missingLandmarks.length === 0
        ? undefined
        : "Semantic landmarks help screen readers and AI agents navigate page structure.",
    evidence: { ...landmarks },
    priority: missingLandmarks.length === 0 ? 5 : 3,
  });

  // Form label coverage — every input should have a programmatic label.
  const inputs = $("input:not([type='hidden']):not([type='submit']):not([type='button']):not([type='reset']):not([type='image'])").get();
  if (inputs.length > 0) {
    const labeled = inputs.filter((el) => {
      const id = $(el).attr("id");
      const hasLabel = id ? $(`label[for='${id}']`).length > 0 : false;
      const hasAriaLabel = !!$(el).attr("aria-label") || !!$(el).attr("aria-labelledby");
      const hasTitle = !!$(el).attr("title");
      return hasLabel || hasAriaLabel || hasTitle;
    }).length;
    const pct = labeled / inputs.length;
    out.push({
      section: "Accessibility",
      check_key: "spec.a11y.form_labels",
      status: pct >= 0.9 ? "pass" : pct >= 0.5 ? "warn" : "fail",
      title: `Form label coverage: ${(pct * 100).toFixed(0)}% (${labeled}/${inputs.length})`,
      detail:
        pct >= 0.9
          ? undefined
          : "Each form input needs a <label for=…>, aria-label, or aria-labelledby for screen readers.",
      priority: pct >= 0.9 ? 5 : 3,
    });
  }

  // ─── Well-Known URIs ──────────────────────────────────────────────────────

  // /.well-known/change-password — standard redirect for password managers.
  const cp = ctx.wellKnown.changePassword;
  out.push({
    section: "Well-Known URIs",
    check_key: "spec.wk.change_password",
    status: cp && cp.status < 400 ? "pass" : "warn",
    title:
      cp && cp.status < 400
        ? "/.well-known/change-password present"
        : "/.well-known/change-password missing",
    detail:
      cp && cp.status < 400
        ? `HTTP ${cp.status}`
        : "Redirect /.well-known/change-password to your password-change page so password managers can deep-link directly.",
    priority: cp && cp.status < 400 ? 5 : 4,
  });

  // /.well-known/api-catalog — RFC 9727 machine-readable API index.
  const ac = ctx.wellKnown.apiCatalog;
  out.push({
    section: "Well-Known URIs",
    check_key: "spec.wk.api_catalog",
    status: ac && ac.status < 400 ? "pass" : "warn",
    title:
      ac && ac.status < 400
        ? "/.well-known/api-catalog present"
        : "/.well-known/api-catalog missing",
    detail:
      ac && ac.status < 400
        ? `HTTP ${ac.status}`
        : "Publish a /.well-known/api-catalog (RFC 9727 Linkset) so agents can discover your API endpoints automatically.",
    priority: ac && ac.status < 400 ? 5 : 4,
  });

  // /.well-known/agent-card.json — A2A agent discovery.
  const agentCard = ctx.wellKnown.agentCard;
  out.push({
    section: "Well-Known URIs",
    check_key: "spec.wk.agent_card",
    status: agentCard && agentCard.status < 400 ? "pass" : "warn",
    title:
      agentCard && agentCard.status < 400
        ? "/.well-known/agent-card.json present (A2A)"
        : "/.well-known/agent-card.json missing",
    detail:
      agentCard && agentCard.status < 400
        ? `HTTP ${agentCard.status}`
        : "Publish an agent card at /.well-known/agent-card.json to enable agent-to-agent (A2A) discovery.",
    evidence: agentCard?.status === 200 ? { snippet: agentCard.content.slice(0, 300) } : undefined,
    priority: agentCard && agentCard.status < 400 ? 5 : 4,
  });

  // HTTP Link header — advertises llms.txt, sitemap, api-catalog to crawlers.
  const linkHeader = h["link"] ?? "";
  const advertisesLlms = /rel=["']?llms-txt["']?/i.test(linkHeader) || /<[^>]*llms\.txt[^>]*>/i.test(linkHeader);
  const advertisesSitemap = /rel=["']?sitemap["']?/i.test(linkHeader);
  const hasLinkHeader = linkHeader.length > 0;
  out.push({
    section: "Well-Known URIs",
    check_key: "spec.wk.link_header",
    status: hasLinkHeader && (advertisesLlms || advertisesSitemap) ? "pass" : hasLinkHeader ? "warn" : "warn",
    title: !hasLinkHeader
      ? "No HTTP Link header"
      : advertisesLlms || advertisesSitemap
        ? "HTTP Link header advertises key resources"
        : "HTTP Link header present but missing llms-txt/sitemap rel",
    detail: !hasLinkHeader
      ? "Add a Link response header to advertise sitemap, llms.txt, and api-catalog to crawlers without requiring HTML parsing."
      : hasLinkHeader && !advertisesLlms && !advertisesSitemap
        ? `Current: ${linkHeader.slice(0, 200)}\nConsider adding rel=llms-txt and rel=sitemap entries.`
        : linkHeader.slice(0, 300),
    evidence: hasLinkHeader ? { link: linkHeader.slice(0, 500) } : undefined,
    priority: hasLinkHeader && (advertisesLlms || advertisesSitemap) ? 5 : 4,
  });

  // ─── Agent Readiness ──────────────────────────────────────────────────────

  // /llms-full.txt — full markdown content dump for LLMs.
  const llmsFull = ctx.wellKnown.llmsFullTxt;
  out.push({
    section: "LLM / AI Crawler Accessibility",
    check_key: "spec.agent.llms_full",
    status: llmsFull && llmsFull.status === 200 ? "pass" : "warn",
    title:
      llmsFull && llmsFull.status === 200
        ? "/llms-full.txt present"
        : "/llms-full.txt missing",
    detail:
      llmsFull && llmsFull.status === 200
        ? `${llmsFull.content.length} chars — full site content for LLM ingest.`
        : "Add /llms-full.txt with concatenated Markdown of all key pages. Lets LLMs ingest your full site in one request.",
    evidence: llmsFull?.status === 200 ? { bytes: llmsFull.content.length } : undefined,
    priority: llmsFull?.status === 200 ? 5 : 3,
  });

  // ─── Performance ──────────────────────────────────────────────────────────

  // Compression — Brotli or gzip content-encoding.
  const encoding = h["content-encoding"]?.toLowerCase() ?? "";
  const compressedWith = encoding.includes("br")
    ? "Brotli"
    : encoding.includes("gzip")
      ? "gzip"
      : encoding.includes("zstd")
        ? "zstd"
        : null;
  out.push({
    section: "Performance",
    check_key: "spec.perf.compression",
    status: compressedWith ? "pass" : "warn",
    title: compressedWith
      ? `Compression enabled (${compressedWith})`
      : "No Content-Encoding compression detected",
    detail: compressedWith
      ? `Content-Encoding: ${encoding}`
      : "Enable Brotli (preferred) or gzip compression. Reduces transfer size by ~70-80% for HTML.",
    evidence: compressedWith ? { encoding } : undefined,
    priority: compressedWith ? 5 : 3,
  });

  // Lazy loading — images with loading="lazy".
  const allImgs = $("img").get();
  if (allImgs.length > 0) {
    const lazyImgs = allImgs.filter((el) => $(el).attr("loading") === "lazy").length;
    const pct = lazyImgs / allImgs.length;
    out.push({
      section: "Performance",
      check_key: "spec.perf.lazy_loading",
      status: pct >= 0.5 ? "pass" : "warn",
      title:
        lazyImgs === 0
          ? "No images use loading=lazy"
          : `Lazy loading: ${lazyImgs}/${allImgs.length} images`,
      detail:
        pct >= 0.5
          ? undefined
          : 'Add loading="lazy" to off-screen images to defer their fetch until needed.',
      priority: pct >= 0.5 ? 5 : 3,
    });
  }

  // ─── Privacy ──────────────────────────────────────────────────────────────

  // Privacy policy link.
  const privacyLink = $("a[href]")
    .filter((_, el) => /privacy|datenschutz|politique de confidentialité/i.test($(el).text()))
    .first()
    .attr("href");
  out.push({
    section: "Privacy",
    check_key: "spec.privacy.policy",
    status: privacyLink ? "pass" : "warn",
    title: privacyLink ? "Privacy policy link found" : "No privacy policy link found",
    detail: privacyLink
      ? privacyLink
      : "Add a visible link to your privacy policy. Required by GDPR, CCPA, and expected by AI agents assessing trustworthiness.",
    evidence: privacyLink ? { href: privacyLink } : undefined,
    priority: privacyLink ? 5 : 2,
  });

  // Third-party script count — each cross-origin script is a trust/privacy risk.
  const origin = ctx.origin;
  const thirdPartyScripts = $("script[src]")
    .map((_, el) => $(el).attr("src") ?? "")
    .get()
    .filter((src) => {
      try {
        return new URL(src, origin).origin !== origin;
      } catch {
        return false;
      }
    });
  out.push({
    section: "Privacy",
    check_key: "spec.privacy.third_party_scripts",
    status:
      thirdPartyScripts.length === 0
        ? "pass"
        : thirdPartyScripts.length <= 5
          ? "warn"
          : "warn",
    title:
      thirdPartyScripts.length === 0
        ? "No third-party scripts detected"
        : `${thirdPartyScripts.length} third-party script(s) loaded`,
    detail:
      thirdPartyScripts.length === 0
        ? undefined
        : `Each external script can read cookies and page data. Audit: ${thirdPartyScripts.slice(0, 3).join(", ")}`,
    evidence: thirdPartyScripts.length > 0 ? { scripts: thirdPartyScripts.slice(0, 10) } : undefined,
    priority: thirdPartyScripts.length === 0 ? 5 : thirdPartyScripts.length <= 5 ? 4 : 3,
  });

  // ─── Resilience ───────────────────────────────────────────────────────────

  // Web App Manifest — JSON file for PWA install prompts and home-screen icons.
  const manifestHref =
    $("link[rel='manifest']").attr("href") ||
    $("link[rel='web-app-manifest']").attr("href");
  out.push({
    section: "Resilience",
    check_key: "spec.resilience.manifest",
    status: manifestHref ? "pass" : "warn",
    title: manifestHref ? "Web App Manifest declared" : "No Web App Manifest found",
    detail: manifestHref
      ? manifestHref
      : 'Add <link rel="manifest" href="/manifest.json"> and a manifest.json with name, icons, start_url, and display.',
    evidence: manifestHref ? { href: manifestHref } : undefined,
    priority: manifestHref ? 5 : 4,
  });

  return out;
}
