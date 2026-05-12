import * as cheerio from "cheerio";
import type { CrawlContext, Finding } from "../types";

function extractJsonLd(html: string): unknown[] {
  const $ = cheerio.load(html);
  const out: unknown[] = [];
  $("script[type='application/ld+json']").each((_, el) => {
    const raw = $(el).contents().text();
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) out.push(...parsed);
      else if (parsed && typeof parsed === "object" && "@graph" in parsed) {
        const g = (parsed as { "@graph": unknown[] })["@graph"];
        if (Array.isArray(g)) out.push(...g);
        else out.push(parsed);
      } else {
        out.push(parsed);
      }
    } catch {
      out.push({ __invalid: raw.slice(0, 200) });
    }
  });
  return out;
}

function typesOf(blob: unknown[]): string[] {
  return blob
    .map((b) => {
      if (!b || typeof b !== "object") return null;
      const t = (b as Record<string, unknown>)["@type"];
      if (typeof t === "string") return t;
      if (Array.isArray(t)) return t.join("+");
      return null;
    })
    .filter((x): x is string => !!x);
}

export function checkSchema(ctx: CrawlContext): Finding[] {
  const out: Finding[] = [];
  const home = ctx.pages[ctx.target];
  if (!home?.rawHtml) return out;

  const blobs = extractJsonLd(home.rawHtml);
  const types = typesOf(blobs);
  const invalid = blobs.filter(
    (b) => b && typeof b === "object" && "__invalid" in (b as Record<string, unknown>),
  ).length;

  if (blobs.length === 0) {
    out.push({
      section: "Schema / Structured Data Audit",
      check_key: "schema.any",
      status: "fail",
      title: "No JSON-LD structured data found",
      detail:
        "Add JSON-LD blocks (Organization, SoftwareApplication, FAQPage, BreadcrumbList) so AI answer engines can ingest your data without guessing.",
      priority: 1,
    });
    return out;
  }

  out.push({
    section: "Schema / Structured Data Audit",
    check_key: "schema.any",
    status: "pass",
    title: `${blobs.length} JSON-LD block(s) found`,
    detail: `Types: ${types.join(", ") || "(none typed)"}`,
    evidence: { types, blocks: blobs.length },
    priority: 5,
  });

  if (invalid > 0) {
    out.push({
      section: "Schema / Structured Data Audit",
      check_key: "schema.invalid",
      status: "fail",
      title: `${invalid} invalid JSON-LD block(s)`,
      detail: "Found unparseable JSON-LD. Validate via search.google.com/test/rich-results.",
      priority: 1,
    });
  }

  // Required types for an AEO-ready site
  const required: Array<{ key: string; t: string; priority: 1 | 2 | 3 }> = [
    { key: "schema.org", t: "Organization", priority: 2 },
    { key: "schema.web", t: "WebSite", priority: 3 },
    { key: "schema.product", t: "SoftwareApplication", priority: 3 },
  ];
  for (const r of required) {
    const has = types.some((t) => t.includes(r.t));
    out.push({
      section: "Schema / Structured Data Audit",
      check_key: r.key,
      status: has ? "pass" : "warn",
      title: has ? `${r.t} present` : `${r.t} missing`,
      detail: has ? undefined : `Adding ${r.t} JSON-LD helps LLMs identify your entity.`,
      priority: has ? 5 : r.priority,
    });
  }

  // FAQ
  const hasFaq = types.some((t) => t.includes("FAQPage"));
  out.push({
    section: "Schema / Structured Data Audit",
    check_key: "schema.faq",
    status: hasFaq ? "pass" : "warn",
    title: hasFaq ? "FAQPage JSON-LD present" : "FAQPage JSON-LD missing",
    detail: hasFaq
      ? undefined
      : "Add an FAQPage block on pages that answer common questions — high-value for AI summaries.",
    priority: hasFaq ? 5 : 3,
  });

  return out;
}
