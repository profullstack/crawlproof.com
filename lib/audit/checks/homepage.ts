import * as cheerio from "cheerio";
import type { CrawlContext, Finding } from "../types";

export function checkHomepage(ctx: CrawlContext): Finding[] {
  const home = ctx.pages[ctx.target];
  const out: Finding[] = [];
  if (!home || home.status >= 400 || !home.rawHtml) {
    out.push({
      section: "Homepage Audit",
      check_key: "homepage.fetch",
      status: "fail",
      title: "Homepage could not be fetched",
      detail: home?.error ?? `HTTP ${home?.status ?? "0"}`,
      priority: 1,
    });
    return out;
  }

  out.push({
    section: "Homepage Audit",
    check_key: "homepage.fetch",
    status: "pass",
    title: "Homepage fetched successfully",
    detail: `HTTP ${home.status} · ${home.bytes} bytes · ${home.fetchMs}ms`,
    evidence: { status: home.status, bytes: home.bytes, fetchMs: home.fetchMs },
    priority: 5,
  });

  // Page load time grading. Crawlers (including AI bots) deprioritize slow
  // pages — anything over ~3s tends to time out for GPTBot.
  const loadSec = home.fetchMs / 1000;
  out.push({
    section: "Homepage Audit",
    check_key: "homepage.load_time",
    status: loadSec < 1 ? "pass" : loadSec < 3 ? "warn" : "fail",
    title: `Page load time: ${loadSec.toFixed(2)}s`,
    detail:
      loadSec < 1
        ? "Fast — well within AI crawler budgets."
        : loadSec < 3
          ? "Acceptable — consider optimizing for faster crawl times."
          : "Too slow — AI crawlers commonly time out around 3s.",
    evidence: { fetchMs: home.fetchMs },
    priority: loadSec < 1 ? 5 : loadSec < 3 ? 3 : 2,
  });

  const $ = cheerio.load(home.rawHtml);

  // <html lang="…"> — helps engines serve localized results and confirms
  // content language without needing to NLP-detect it.
  const lang = $("html").attr("lang")?.trim();
  out.push({
    section: "Homepage Audit",
    check_key: "homepage.lang",
    status: lang ? "pass" : "warn",
    title: lang ? `<html lang="${lang}"> declared` : "Missing <html lang> attribute",
    detail: lang
      ? undefined
      : 'Add a lang attribute on the root <html> tag (e.g. <html lang="en">) so AI engines serve language-appropriate results.',
    evidence: lang ? { lang } : undefined,
    priority: lang ? 5 : 3,
  });

  // H1
  const h1s = $("h1").map((_, el) => $(el).text().trim()).get().filter(Boolean);
  if (h1s.length === 0) {
    out.push({
      section: "Homepage Audit",
      check_key: "homepage.h1",
      status: "fail",
      title: "Missing H1",
      detail: "No `<h1>` element found. LLMs use the H1 as the strongest signal of what the page is about.",
      priority: 1,
    });
  } else if (h1s.length > 1) {
    out.push({
      section: "Homepage Audit",
      check_key: "homepage.h1",
      status: "warn",
      title: "Multiple H1s found",
      detail: `${h1s.length} \`<h1>\` tags. Prefer one focused H1 per page.`,
      evidence: { h1s },
      priority: 3,
    });
  } else {
    out.push({
      section: "Homepage Audit",
      check_key: "homepage.h1",
      status: "pass",
      title: "Single H1",
      detail: h1s[0]!.slice(0, 200),
      evidence: { h1: h1s[0] },
      priority: 5,
    });
  }

  // Title — flag both too-short and too-long. Search/answer engines truncate
  // around 60 chars and AI bots use short titles as a weak signal of intent.
  const title = $("title").first().text().trim();
  const titleLooksLikeError = /\b(502|503|504|bad gateway|service unavailable|gateway timeout|not found)\b/i.test(title);
  if (!title) {
    out.push({
      section: "Homepage Audit",
      check_key: "homepage.title",
      status: "fail",
      title: "Missing `<title>`",
      detail: "The `<title>` tag is required for search and answer engines.",
      priority: 1,
    });
  } else if (titleLooksLikeError) {
    out.push({
      section: "Homepage Audit",
      check_key: "homepage.title",
      status: "fail",
      title: "`<title>` looks like an error page",
      detail: `Title is "${title}" — the crawl may have hit a server error or downtime. Re-scan when the site is healthy.`,
      evidence: { title },
      priority: 1,
    });
  } else if (title.length < 30) {
    out.push({
      section: "Homepage Audit",
      check_key: "homepage.title",
      status: "warn",
      title: `Short \`<title>\` (${title.length} chars)`,
      detail: "Aim for 30–60 chars. Lead with brand or product, then value prop.",
      evidence: { title },
      priority: 3,
    });
  } else if (title.length > 70) {
    out.push({
      section: "Homepage Audit",
      check_key: "homepage.title",
      status: "warn",
      title: `Long \`<title>\` (${title.length} chars)`,
      detail: "Engines and AI snippets truncate titles around 60–70 chars. Trim to keep the key phrase visible.",
      evidence: { title },
      priority: 3,
    });
  } else {
    out.push({
      section: "Homepage Audit",
      check_key: "homepage.title",
      status: "pass",
      title: `\`<title>\` present (${title.length} chars)`,
      evidence: { title },
      priority: 5,
    });
  }

  // Meta description — length tiers (Google truncates ~155, AI bots use it
  // as the default snippet).
  const description = $("meta[name='description']").attr("content")?.trim();
  if (!description) {
    out.push({
      section: "Homepage Audit",
      check_key: "homepage.description",
      status: "warn",
      title: "Missing meta description",
      detail: "Add a `<meta name=\"description\">` to control the snippet AI/SERP show.",
      priority: 2,
    });
  } else if (description.length < 50) {
    out.push({
      section: "Homepage Audit",
      check_key: "homepage.description",
      status: "warn",
      title: `Short meta description (${description.length} chars)`,
      detail: "Aim for 50–160 chars. Restate your value prop in plain language.",
      evidence: { description },
      priority: 3,
    });
  } else if (description.length > 160) {
    out.push({
      section: "Homepage Audit",
      check_key: "homepage.description",
      status: "warn",
      title: `Long meta description (${description.length} chars)`,
      detail: "Snippets truncate around 160 chars. Tighten to keep the key sentence visible.",
      evidence: { description },
      priority: 3,
    });
  } else {
    out.push({
      section: "Homepage Audit",
      check_key: "homepage.description",
      status: "pass",
      title: `Meta description present (${description.length} chars)`,
      evidence: { description },
      priority: 5,
    });
  }

  // Canonical
  const canonical = $("link[rel='canonical']").attr("href");
  out.push({
    section: "Homepage Audit",
    check_key: "homepage.canonical",
    status: canonical ? "pass" : "warn",
    title: canonical ? "Canonical present" : "Missing canonical link",
    detail: canonical ?? "Add `<link rel=\"canonical\" href=\"https://your-domain\">` to prevent dup-content confusion.",
    evidence: canonical ? { canonical } : undefined,
    priority: canonical ? 5 : 3,
  });

  // Open Graph
  const og = {
    title: $("meta[property='og:title']").attr("content"),
    description: $("meta[property='og:description']").attr("content"),
    image: $("meta[property='og:image']").attr("content"),
  };
  const ogMissing = Object.entries(og).filter(([, v]) => !v).map(([k]) => k);
  out.push({
    section: "Homepage Audit",
    check_key: "homepage.og",
    status: ogMissing.length === 0 ? "pass" : ogMissing.length === 3 ? "fail" : "warn",
    title:
      ogMissing.length === 0
        ? "Open Graph tags complete"
        : `Open Graph: missing ${ogMissing.join(", ")}`,
    evidence: og as Record<string, unknown>,
    priority: ogMissing.length === 0 ? 5 : 3,
  });

  // Twitter Card — AI link previews and social agents both consume these.
  const twitter = {
    card: $("meta[name='twitter:card']").attr("content"),
    title: $("meta[name='twitter:title']").attr("content"),
    description: $("meta[name='twitter:description']").attr("content"),
    image: $("meta[name='twitter:image']").attr("content"),
  };
  const twitterMissing = Object.entries(twitter).filter(([, v]) => !v).map(([k]) => k);
  out.push({
    section: "Homepage Audit",
    check_key: "homepage.twitter",
    status: twitterMissing.length === 0 ? "pass" : twitterMissing.length === 4 ? "warn" : "warn",
    title:
      twitterMissing.length === 0
        ? "Twitter Card tags complete"
        : twitterMissing.length === 4
          ? "No Twitter Card tags"
          : `Twitter Card: missing ${twitterMissing.join(", ")}`,
    detail:
      twitterMissing.length === 0
        ? undefined
        : "Add twitter:card, twitter:title, twitter:description, twitter:image for richer previews in social and AI agent surfaces.",
    evidence: twitter as Record<string, unknown>,
    priority: twitterMissing.length === 0 ? 5 : 3,
  });

  // JS-rendered content check
  if (home.renderedText && home.renderedBytes) {
    const rawText = $.root().text().replace(/\s+/g, " ").trim();
    const renderedText = home.renderedText.replace(/\s+/g, " ").trim();
    const ratio = rawText.length === 0 ? 999 : renderedText.length / Math.max(rawText.length, 1);
    if (ratio > 2.0) {
      out.push({
        section: "Homepage Audit",
        check_key: "homepage.js_rendered",
        status: "fail",
        title: "Important content appears to be JavaScript-rendered",
        detail: `Raw HTML contains ${rawText.length} chars of text; rendered DOM contains ${renderedText.length} (${ratio.toFixed(1)}× more). LLM crawlers like GPTBot generally do not run JavaScript — they will miss most of your content.`,
        evidence: { rawTextLen: rawText.length, renderedTextLen: renderedText.length, ratio },
        priority: 1,
      });
    } else if (ratio > 1.3) {
      out.push({
        section: "Homepage Audit",
        check_key: "homepage.js_rendered",
        status: "warn",
        title: "Some content is JS-rendered",
        detail: `Rendered text is ${ratio.toFixed(1)}× the raw HTML text. Consider SSR for any content critical to comprehension.`,
        evidence: { rawTextLen: rawText.length, renderedTextLen: renderedText.length, ratio },
        priority: 2,
      });
    } else {
      out.push({
        section: "Homepage Audit",
        check_key: "homepage.js_rendered",
        status: "pass",
        title: "Critical content is server-rendered",
        detail: `Raw and rendered text are within ${(ratio * 100).toFixed(0)}% of each other.`,
        evidence: { rawTextLen: rawText.length, renderedTextLen: renderedText.length, ratio },
        priority: 5,
      });
    }
  }

  // Image alt coverage
  const imgs = $("img").get();
  const imgsWithAlt = imgs.filter((el) => ($(el).attr("alt") ?? "").trim() !== "").length;
  if (imgs.length > 0) {
    const pct = imgsWithAlt / imgs.length;
    out.push({
      section: "Homepage Audit",
      check_key: "homepage.alt_text",
      status: pct >= 0.9 ? "pass" : pct >= 0.5 ? "warn" : "fail",
      title: `Alt text coverage: ${(pct * 100).toFixed(0)}%`,
      detail: `${imgsWithAlt}/${imgs.length} images have alt text.`,
      priority: pct >= 0.9 ? 5 : 3,
    });
  }

  // Content volume — AI models need enough substance to summarize. Count
  // visible text in <body>, ignoring scripts/styles/templates.
  const $body = $("body").clone();
  $body.find("script, style, noscript, template").remove();
  const visibleText = $body.text().replace(/\s+/g, " ").trim();
  const wordCount = visibleText ? visibleText.split(/\s+/).length : 0;
  out.push({
    section: "Homepage Audit",
    check_key: "homepage.word_count",
    status: wordCount >= 300 ? "pass" : wordCount >= 100 ? "warn" : "fail",
    title: `Content volume: ${wordCount} words`,
    detail:
      wordCount >= 300
        ? "Substantive content — AI models have enough to summarize and recommend."
        : wordCount >= 100
          ? "Thin content. Aim for 300+ words on the homepage so AI models can extract a useful description."
          : "Very thin content. AI models need substantive text to understand and recommend your site.",
    evidence: { wordCount },
    priority: wordCount >= 300 ? 5 : wordCount >= 100 ? 3 : 1,
  });

  // Heading hierarchy — AI uses h1/h2/h3 to chunk content. A flat document
  // with one heading is harder to parse than one with sectioned structure.
  const h2Count = $("h2").length;
  const h3Count = $("h3").length;
  const totalHeadings = h1s.length + h2Count + h3Count;
  out.push({
    section: "Homepage Audit",
    check_key: "homepage.heading_structure",
    status: totalHeadings >= 3 ? "pass" : totalHeadings >= 1 ? "warn" : "fail",
    title: `Heading structure: ${totalHeadings} (h1:${h1s.length}, h2:${h2Count}, h3:${h3Count})`,
    detail:
      totalHeadings >= 3
        ? "Multiple headings help AI chunk and outline your page."
        : "Few headings make it hard for AI to understand sectioning. Use h2/h3 to label each section.",
    evidence: { h1: h1s.length, h2: h2Count, h3: h3Count },
    priority: totalHeadings >= 3 ? 5 : 3,
  });

  // Internal link count — AI crawlers follow links to discover the rest of
  // the site. Need at least a nav-worth.
  const allLinks = $("a[href]").get();
  let internalLinks = 0;
  let externalLinks = 0;
  for (const a of allLinks) {
    const href = $(a).attr("href") ?? "";
    if (!href || href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:")) continue;
    try {
      const u = new URL(href, ctx.target);
      if (u.hostname === ctx.host) internalLinks++;
      else externalLinks++;
    } catch {
      // skip invalid hrefs
    }
  }
  out.push({
    section: "Homepage Audit",
    check_key: "homepage.internal_links",
    status: internalLinks >= 5 ? "pass" : internalLinks >= 1 ? "warn" : "fail",
    title: `Internal links: ${internalLinks}`,
    detail:
      internalLinks >= 5
        ? `${internalLinks} internal + ${externalLinks} external links help crawlers navigate.`
        : "Few internal links. Add a nav/footer with links to your key pages so AI crawlers can discover them.",
    evidence: { internal: internalLinks, external: externalLinks },
    priority: internalLinks >= 5 ? 5 : 3,
  });

  return out;
}
