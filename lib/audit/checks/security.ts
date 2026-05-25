import * as cheerio from "cheerio";
import type { CrawlContext, Finding } from "../types";

// Transport security + common response headers. AI trust signals lean on
// these — a missing HSTS or unencrypted assets reduce a site's perceived
// authority in answer engines.
export function checkSecurity(ctx: CrawlContext): Finding[] {
  const home = ctx.pages[ctx.target];
  const out: Finding[] = [];
  if (!home) return out;

  // HTTPS — required. We already normalize to https in the engine, but the
  // *final* URL after redirects is the truth.
  const finalUrl = home.finalUrl || home.url;
  const isHttps = finalUrl.startsWith("https://");
  out.push({
    section: "Security",
    check_key: "security.https",
    status: isHttps ? "pass" : "fail",
    title: isHttps ? "Served over HTTPS" : "Site is not served over HTTPS",
    detail: isHttps
      ? undefined
      : "AI crawlers and most browsers treat HTTP as untrusted. Force HTTPS at the edge.",
    evidence: { finalUrl },
    priority: isHttps ? 5 : 1,
  });

  // Mixed content — assets loaded over http on an https page.
  if (isHttps && home.rawHtml) {
    const $ = cheerio.load(home.rawHtml);
    const insecure: string[] = [];
    $("script[src], link[href], img[src], iframe[src], video[src], source[src]").each((_, el) => {
      const $el = $(el);
      const url = $el.attr("src") || $el.attr("href") || "";
      if (/^http:\/\//i.test(url)) insecure.push(url);
    });
    out.push({
      section: "Security",
      check_key: "security.mixed_content",
      status: insecure.length === 0 ? "pass" : "fail",
      title:
        insecure.length === 0
          ? "No mixed content detected"
          : `${insecure.length} insecure resource(s) on an https page`,
      detail:
        insecure.length === 0
          ? undefined
          : `Update to https:// or use protocol-relative URLs.\nExamples:\n${insecure.slice(0, 3).map((u) => `· ${u}`).join("\n")}`,
      evidence: insecure.length === 0 ? undefined : { examples: insecure.slice(0, 5) },
      priority: insecure.length === 0 ? 5 : 1,
    });
  }

  // Security response headers. Missing is warn (browser-side, doesn't break
  // AI crawls) — but each one is a trust signal.
  const h = home.headers;
  const checks: Array<{
    key: string;
    header: string;
    label: string;
    priority: 1 | 2 | 3 | 4 | 5;
    advice: string;
  }> = [
    {
      key: "security.hsts",
      header: "strict-transport-security",
      label: "HSTS",
      priority: 3,
      advice: "Add `Strict-Transport-Security: max-age=31536000; includeSubDomains` once you're confident in https.",
    },
    {
      key: "security.csp",
      header: "content-security-policy",
      label: "Content-Security-Policy",
      priority: 3,
      advice: "Define a CSP to limit script sources — large reduction in XSS surface.",
    },
    {
      key: "security.xfo",
      header: "x-frame-options",
      label: "X-Frame-Options",
      priority: 4,
      advice: "Add `X-Frame-Options: SAMEORIGIN` (or use CSP frame-ancestors) to prevent clickjacking.",
    },
    {
      key: "security.xcto",
      header: "x-content-type-options",
      label: "X-Content-Type-Options",
      priority: 4,
      advice: "Add `X-Content-Type-Options: nosniff` to block MIME-type sniffing.",
    },
    {
      key: "security.referrer",
      header: "referrer-policy",
      label: "Referrer-Policy",
      priority: 4,
      advice: "Add `Referrer-Policy: strict-origin-when-cross-origin` for safer referrers.",
    },
    {
      key: "security.permissions",
      header: "permissions-policy",
      label: "Permissions-Policy",
      priority: 4,
      advice: "Restrict browser features (camera, mic, geolocation) you don't use.",
    },
  ];
  for (const c of checks) {
    const v = h[c.header];
    out.push({
      section: "Security",
      check_key: c.key,
      status: v ? "pass" : "warn",
      title: v ? `${c.label} set` : `${c.label} missing`,
      detail: v ? v.length > 120 ? `${v.slice(0, 120)}…` : v : c.advice,
      evidence: v ? { value: v } : undefined,
      priority: v ? 5 : c.priority,
    });
  }

  return out;
}
