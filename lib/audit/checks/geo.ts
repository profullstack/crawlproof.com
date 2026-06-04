import * as cheerio from "cheerio";
import type { CrawlContext, Finding } from "../types";

// Domains that anchor a brand as a known entity in AI knowledge graphs.
const KNOWLEDGE_GRAPH_DOMAINS = [
  "wikipedia.org",
  "wikidata.org",
  "linkedin.com",
  "crunchbase.com",
  "bloomberg.com",
  "reuters.com",
  "g2.com",
  "glassdoor.com",
  "github.com",
  "ycombinator.com",
  "pitchbook.com",
];

// Outbound-link targets that signal epistemic trustworthiness to AI systems.
const AUTHORITY_DOMAINS = [
  "wikipedia.org",
  ".gov",
  ".edu",
  "pubmed.ncbi.nlm.nih.gov",
  "scholar.google",
  "statista.com",
  "gartner.com",
  "forrester.com",
  "mckinsey.com",
  "hbr.org",
  "nature.com",
  "reuters.com",
  "apnews.com",
  "bloomberg.com",
  "wsj.com",
  "ft.com",
];

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
      /* skip invalid */
    }
  });
  return out;
}

const ORG_TYPES = new Set([
  "Organization",
  "Corporation",
  "LocalBusiness",
  "SoftwareApplication",
  "WebSite",
]);

function findOrgSchema(blobs: unknown[]): Record<string, unknown> | null {
  for (const b of blobs) {
    if (!b || typeof b !== "object") continue;
    const obj = b as Record<string, unknown>;
    const t = obj["@type"];
    const types = Array.isArray(t) ? t : [t];
    if (types.some((x) => typeof x === "string" && ORG_TYPES.has(x))) return obj;
  }
  return null;
}

export function checkGeo(ctx: CrawlContext): Finding[] {
  const out: Finding[] = [];
  const home = ctx.pages[ctx.target];
  const { llmsTxt, llmsFullTxt, aiPlugin, agentCard, skillMd } = ctx.wellKnown;
  const SECTION = "Generative Engine Optimization (GEO)";

  // ----------------------------------------------------------------
  // 1. llms.txt quality — beyond existence, assess content depth
  //    (existence is checked in spec-compliance; here we check value)
  // ----------------------------------------------------------------
  if (!llmsTxt || llmsTxt.status >= 400) {
    out.push({
      section: SECTION,
      check_key: "geo.llms_txt",
      status: "fail",
      title: "No llms.txt found",
      detail:
        "llms.txt tells generative AI systems what to read, index, and cite. " +
        "Create /llms.txt following the llmstxt.org spec — include headings, " +
        "page descriptions, and links to key resources.",
      priority: 1,
    });
  } else {
    const content = llmsTxt.content;
    const lines = content.split(/\r?\n/).filter((l) => l.trim());
    const headings = lines.filter((l) => l.startsWith("#")).length;
    const urlLines = lines.filter((l) => /https?:\/\//.test(l)).length;
    const words = content.split(/\s+/).filter(Boolean).length;
    const isRich = headings >= 2 && urlLines >= 3 && words >= 50;

    out.push({
      section: SECTION,
      check_key: "geo.llms_txt",
      status: isRich ? "pass" : "warn",
      title: isRich
        ? "llms.txt present with meaningful content"
        : "llms.txt exists but lacks depth",
      detail: isRich
        ? `${headings} section(s), ${urlLines} linked resource(s), ${words} words.`
        : `Only ${headings} heading(s), ${urlLines} link(s), ${words} words. ` +
          "Add more sections, per-page descriptions, and resource links so generative AI " +
          "has rich context when citing your site.",
      evidence: { headings, urlLines, words, snippet: content.slice(0, 400) },
      priority: isRich ? 4 : 2,
    });
  }

  // ----------------------------------------------------------------
  // 2. llms-full.txt — complete content dump for RAG pipelines
  // ----------------------------------------------------------------
  if (!llmsFullTxt || llmsFullTxt.status >= 400) {
    out.push({
      section: SECTION,
      check_key: "geo.llms_full_txt",
      status: "warn",
      title: "No llms-full.txt found",
      detail:
        "llms-full.txt is an extended version of llms.txt that embeds the full text of " +
        "every listed resource. Large-context models and RAG pipelines can ingest your " +
        "entire site in one request — greatly improving citation coverage.",
      priority: 3,
    });
  } else {
    const words = llmsFullTxt.content.split(/\s+/).filter(Boolean).length;
    out.push({
      section: SECTION,
      check_key: "geo.llms_full_txt",
      status: "pass",
      title: `llms-full.txt present (${words.toLocaleString()} words)`,
      detail:
        "Full-content AI ingestion file available. RAG pipelines and large-context models " +
        "can consume your entire knowledge base in one request.",
      evidence: { words },
      priority: 5,
    });
  }

  // ----------------------------------------------------------------
  // 3. Knowledge graph anchoring — sameAs links in Organization schema
  // ----------------------------------------------------------------
  if (home?.rawHtml) {
    const blobs = extractJsonLd(home.rawHtml);
    const org = findOrgSchema(blobs);

    if (!org) {
      out.push({
        section: SECTION,
        check_key: "geo.knowledge_graph",
        status: "warn",
        title: "No Organization schema — brand cannot be anchored in knowledge graphs",
        detail:
          "Add an Organization JSON-LD block with `sameAs` links to Wikipedia, Wikidata, " +
          "LinkedIn, or Crunchbase. This resolves your brand as a distinct entity in AI " +
          "knowledge graphs, significantly improving citation likelihood.",
        priority: 2,
      });
    } else {
      const raw = org["sameAs"];
      const sameAsAll: string[] = Array.isArray(raw)
        ? raw.filter((x): x is string => typeof x === "string")
        : typeof raw === "string"
          ? [raw]
          : [];
      const kgLinks = sameAsAll.filter((link) =>
        KNOWLEDGE_GRAPH_DOMAINS.some((d) => link.includes(d)),
      );

      if (kgLinks.length === 0) {
        out.push({
          section: SECTION,
          check_key: "geo.knowledge_graph",
          status: "warn",
          title: "Organization schema has no knowledge graph sameAs links",
          detail:
            "Add `sameAs` pointing to Wikipedia, Wikidata, LinkedIn, or Crunchbase. " +
            "AI systems use these links to resolve your brand name as a known entity " +
            "rather than an ambiguous string.",
          evidence: { existingSameAs: sameAsAll },
          priority: 2,
        });
      } else {
        out.push({
          section: SECTION,
          check_key: "geo.knowledge_graph",
          status: "pass",
          title: `Brand anchored in ${kgLinks.length} knowledge graph source(s)`,
          detail: kgLinks.join(", "),
          evidence: { kgLinks },
          priority: 5,
        });
      }
    }
  }

  // ----------------------------------------------------------------
  // 4. AI agent integration — plugin/agent/skill files
  // ----------------------------------------------------------------
  const agentFiles: string[] = [];
  if (aiPlugin && aiPlugin.status < 400) agentFiles.push("ai-plugin.json");
  if (agentCard && agentCard.status < 400) agentFiles.push("agent-card.json");
  if (skillMd && skillMd.status < 400) agentFiles.push("skill.md");

  if (agentFiles.length === 0) {
    out.push({
      section: SECTION,
      check_key: "geo.agent_integration",
      status: "warn",
      title: "No AI agent integration files found",
      detail:
        "Add at least one: /.well-known/ai-plugin.json (ChatGPT plugin discovery), " +
        "/.well-known/agent-card.json (A2A protocol), or /skill.md (Claude tool " +
        "integration). These let AI agents interact with your site programmatically " +
        "and signal that your site is AI-native.",
      priority: 2,
    });
  } else {
    out.push({
      section: SECTION,
      check_key: "geo.agent_integration",
      status: "pass",
      title: `AI agent integration files present: ${agentFiles.join(", ")}`,
      detail:
        "Generative AI agents can discover and use your site's capabilities via " +
        "standard integration files.",
      evidence: { files: agentFiles },
      priority: 5,
    });
  }

  // ----------------------------------------------------------------
  // 5. Brand entity clarity — schema.name consistency
  // ----------------------------------------------------------------
  if (home?.rawHtml) {
    const blobs = extractJsonLd(home.rawHtml);
    const org = findOrgSchema(blobs);
    const schemaName = org?.["name"];

    if (!schemaName || typeof schemaName !== "string") {
      out.push({
        section: SECTION,
        check_key: "geo.brand_entity",
        status: "warn",
        title: "Brand name not declared in structured data",
        detail:
          "Add a `name` field to your Organization (or SoftwareApplication) JSON-LD block. " +
          "AI systems use this to recognise your brand as a distinct, citable entity rather " +
          "than inferring it from page text.",
        priority: 2,
      });
    } else {
      out.push({
        section: SECTION,
        check_key: "geo.brand_entity",
        status: "pass",
        title: `Brand entity declared: "${schemaName}"`,
        detail:
          `AI systems can resolve "${schemaName}" as a distinct entity. ` +
          "Ensure this name is used consistently in titles, H1s, and social profiles.",
        evidence: { schemaName },
        priority: 5,
      });
    }
  }

  // ----------------------------------------------------------------
  // 6. Citation signals — outbound links to authoritative sources
  // ----------------------------------------------------------------
  if (home?.rawHtml) {
    const $ = cheerio.load(home.rawHtml);
    const outbound: string[] = [];
    $("a[href]").each((_, el) => {
      const href = $(el).attr("href") ?? "";
      try {
        const u = new URL(href, ctx.origin);
        if (u.origin !== ctx.origin) outbound.push(u.href);
      } catch {
        /* skip */
      }
    });

    const authoritative = outbound.filter((link) =>
      AUTHORITY_DOMAINS.some((d) => link.includes(d)),
    );

    if (authoritative.length === 0) {
      out.push({
        section: SECTION,
        check_key: "geo.citation_signals",
        status: "warn",
        title: "No outbound links to authoritative sources on the homepage",
        detail:
          "Generative AI systems cite pages that themselves cite credible sources. " +
          "Link to Wikipedia, .gov, .edu, peer-reviewed research, or major news outlets " +
          "to signal epistemic trustworthiness.",
        priority: 3,
      });
    } else {
      out.push({
        section: SECTION,
        check_key: "geo.citation_signals",
        status: "pass",
        title: `${authoritative.length} outbound citation(s) to authoritative sources`,
        detail: authoritative.slice(0, 3).join(", "),
        evidence: { examples: authoritative.slice(0, 5) },
        priority: 5,
      });
    }
  }

  return out;
}
