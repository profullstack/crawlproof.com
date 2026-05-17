import * as cheerio from "cheerio";
import type { CrawlContext, Finding } from "../types";

const MAX_BROKEN_CHECKS = 20;
const HEAD_TIMEOUT_MS = 6000;
const UA = "CrawlProofBot/1.0 (+https://crawlproof.com/bot)";

// Quick HEAD probe. Some servers reject HEAD with 405 — fall back to GET.
async function probeStatus(url: string): Promise<number> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEAD_TIMEOUT_MS);
  try {
    let res = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      signal: controller.signal,
      headers: { "user-agent": UA },
    });
    if (res.status === 405 || res.status === 501) {
      res = await fetch(url, {
        method: "GET",
        redirect: "follow",
        signal: controller.signal,
        headers: { "user-agent": UA, range: "bytes=0-0" },
      });
    }
    return res.status;
  } catch {
    return 0;
  } finally {
    clearTimeout(timer);
  }
}

// nofollow ratio and a small broken-link sample. Broken-link checking is
// capped at MAX_BROKEN_CHECKS to keep the free-tier audit under ~2s of
// added latency.
export async function checkLinks(ctx: CrawlContext): Promise<Finding[]> {
  const home = ctx.pages[ctx.target];
  const out: Finding[] = [];
  if (!home?.rawHtml) return out;
  const $ = cheerio.load(home.rawHtml);

  const links: Array<{ url: string; rel: string; internal: boolean }> = [];
  $("a[href]").each((_, a) => {
    const $a = $(a);
    const href = ($a.attr("href") || "").trim();
    if (!href || href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:") || href.startsWith("javascript:")) {
      return;
    }
    try {
      const u = new URL(href, ctx.target);
      if (!/^https?:$/.test(u.protocol)) return;
      links.push({
        url: u.toString(),
        rel: ($a.attr("rel") || "").toLowerCase(),
        internal: u.hostname === ctx.host,
      });
    } catch {
      // skip
    }
  });

  if (links.length === 0) return out;

  // nofollow ratio on outbound links — too much nofollow looks like a PBN
  // / link-spam pattern; too little can leak link equity.
  const external = links.filter((l) => !l.internal);
  const nofollow = external.filter((l) => /\bnofollow\b/.test(l.rel)).length;
  if (external.length > 0) {
    const pct = nofollow / external.length;
    out.push({
      section: "Links & Images",
      check_key: "links.nofollow_ratio",
      status: pct < 0.5 ? "pass" : pct < 0.9 ? "warn" : "fail",
      title: `External nofollow: ${(pct * 100).toFixed(0)}% (${nofollow}/${external.length})`,
      detail:
        pct < 0.5
          ? "Healthy mix of follow and nofollow outbound links."
          : pct < 0.9
            ? "Most external links are nofollow. Verify this matches your link policy."
            : "Nearly all external links are nofollow — this can read as a link-graph anti-pattern.",
      priority: pct < 0.5 ? 5 : pct < 0.9 ? 4 : 3,
    });
  }

  // Broken-link sample. Dedupe by URL, take first N, HEAD-check in parallel.
  const seen = new Set<string>();
  const sample: string[] = [];
  for (const l of links) {
    if (seen.has(l.url)) continue;
    seen.add(l.url);
    sample.push(l.url);
    if (sample.length >= MAX_BROKEN_CHECKS) break;
  }
  const statuses = await Promise.all(sample.map((u) => probeStatus(u)));
  const broken = sample
    .map((url, i) => ({ url, status: statuses[i]! }))
    .filter((r) => r.status === 0 || r.status >= 400);

  out.push({
    section: "Links & Images",
    check_key: "links.broken_sample",
    status: broken.length === 0 ? "pass" : broken.length <= 1 ? "warn" : "fail",
    title:
      broken.length === 0
        ? `No broken links in first ${sample.length}`
        : `${broken.length} broken link(s) in first ${sample.length}`,
    detail:
      broken.length === 0
        ? "HEAD-probed the first 20 unique homepage links — all 2xx/3xx."
        : broken.map((b) => `· ${b.status || "timeout"} — ${b.url}`).join("\n"),
    evidence: { sampled: sample.length, broken: broken.length, examples: broken.slice(0, 5) },
    priority: broken.length === 0 ? 5 : broken.length <= 1 ? 3 : 1,
  });

  return out;
}
