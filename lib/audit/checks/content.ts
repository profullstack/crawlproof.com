import * as cheerio from "cheerio";
import type { CrawlContext, Finding } from "../types";

// AEO-focused content shape checks: snippet-ready blocks (lists/tables),
// Q&A formatting, dates, author signals, and code-to-content ratio.
export function checkContent(ctx: CrawlContext): Finding[] {
  const home = ctx.pages[ctx.target];
  const out: Finding[] = [];
  if (!home?.rawHtml) return out;
  const $ = cheerio.load(home.rawHtml);

  // Heading hierarchy: penalize skipped levels (e.g. h2 -> h4) because LLMs
  // use heading depth to build the page outline.
  const headingLevels: number[] = [];
  $("h1, h2, h3, h4, h5, h6").each((_, el) => {
    const tag = (el as { tagName?: string }).tagName?.toLowerCase();
    if (!tag) return;
    const level = parseInt(tag.slice(1), 10);
    if (!Number.isNaN(level)) headingLevels.push(level);
  });
  let skips = 0;
  for (let i = 1; i < headingLevels.length; i++) {
    if (headingLevels[i]! - headingLevels[i - 1]! > 1) skips++;
  }
  if (headingLevels.length > 1) {
    out.push({
      section: "Content Quality",
      check_key: "content.heading_order",
      status: skips === 0 ? "pass" : skips <= 2 ? "warn" : "fail",
      title: skips === 0 ? "Heading levels are well-ordered" : `${skips} heading-level skip(s)`,
      detail:
        skips === 0
          ? `${headingLevels.length} headings nested in order.`
          : "Heading levels jump (e.g. h2 → h4). AI outline parsers expect monotonic nesting.",
      evidence: { levels: headingLevels },
      priority: skips === 0 ? 5 : skips <= 2 ? 3 : 2,
    });
  }

  // Lists and tables — snippet-ready blocks that AI answer engines lift
  // verbatim into structured replies.
  const ulCount = $("ul").length;
  const olCount = $("ol").length;
  const tableCount = $("table").length;
  const snippetBlocks = ulCount + olCount + tableCount;
  out.push({
    section: "Content Quality",
    check_key: "content.snippet_blocks",
    status: snippetBlocks >= 2 ? "pass" : snippetBlocks >= 1 ? "warn" : "fail",
    title: `Snippet-ready blocks: ${snippetBlocks} (ul:${ulCount}, ol:${olCount}, table:${tableCount})`,
    detail:
      snippetBlocks >= 2
        ? "Lists and tables are extracted verbatim by AI answer engines."
        : "Add bullet lists, numbered steps, or a comparison table. Answer engines prefer structured blocks over prose.",
    evidence: { ul: ulCount, ol: olCount, tables: tableCount },
    priority: snippetBlocks >= 2 ? 5 : snippetBlocks >= 1 ? 3 : 2,
  });

  // Definition lists — explicit term/definition pairs are gold for AI
  // glossaries and direct-answer extraction.
  const dlCount = $("dl").length;
  if (dlCount > 0) {
    out.push({
      section: "Content Quality",
      check_key: "content.definition_lists",
      status: "pass",
      title: `${dlCount} definition list(s) present`,
      detail: "Definition lists give AI answer engines explicit term→meaning pairs.",
      priority: 5,
    });
  }

  // Q&A formatting — headings that look like questions are a strong AEO
  // signal even without FAQPage schema.
  const questionHeadings = $("h2, h3, h4")
    .map((_, el) => $(el).text().trim())
    .get()
    .filter((t) => /\?\s*$/.test(t));
  if (questionHeadings.length > 0) {
    out.push({
      section: "Content Quality",
      check_key: "content.qa_headings",
      status: "pass",
      title: `${questionHeadings.length} question-style heading(s)`,
      detail: "Questions in headings map cleanly to user queries. Pair with FAQPage JSON-LD for max lift.",
      evidence: { samples: questionHeadings.slice(0, 5) },
      priority: 5,
    });
  } else {
    out.push({
      section: "Content Quality",
      check_key: "content.qa_headings",
      status: "warn",
      title: "No question-style headings found",
      detail: "Phrase at least one heading as a user question (e.g. 'How does pricing work?') to match conversational AI queries.",
      priority: 3,
    });
  }

  // Last-updated / published date signals — AI engines weight freshness.
  const timeTags = $("time[datetime]").length;
  const publishedMeta =
    $("meta[property='article:published_time']").attr("content") ||
    $("meta[property='og:updated_time']").attr("content") ||
    $("meta[name='date']").attr("content");
  const hasDate = timeTags > 0 || !!publishedMeta;
  out.push({
    section: "Content Quality",
    check_key: "content.date_signal",
    status: hasDate ? "pass" : "warn",
    title: hasDate ? "Date signal present" : "No date signal found",
    detail: hasDate
      ? `time[datetime]: ${timeTags}${publishedMeta ? `, meta: ${publishedMeta}` : ""}`
      : "Add <time datetime=\"…\"> or article:published_time meta. AI ranking weights freshness.",
    priority: hasDate ? 5 : 3,
  });

  // Author byline / E-E-A-T — explicit author marks help AI engines route
  // questions of authority.
  const hasAuthorMeta = !!(
    $("meta[name='author']").attr("content") ||
    $("meta[property='article:author']").attr("content") ||
    $("[rel='author']").length > 0
  );
  // Author schema is detected separately in schema.ts (schema.person).
  out.push({
    section: "Content Quality",
    check_key: "content.author",
    status: hasAuthorMeta ? "pass" : "warn",
    title: hasAuthorMeta ? "Author byline declared" : "No author byline found",
    detail: hasAuthorMeta
      ? undefined
      : 'Add `<meta name="author" content="Name">` or a visible byline with `rel="author"`. Strengthens E-E-A-T signals.',
    priority: hasAuthorMeta ? 5 : 4,
  });

  // Content-to-code ratio — pages that are 95% script tags are hard for AI
  // crawlers (which don't run JS) to summarize.
  const rawLen = home.rawHtml.length;
  const $body = $("body").clone();
  $body.find("script, style, noscript, template").remove();
  const textLen = $body.text().replace(/\s+/g, " ").trim().length;
  const ratio = rawLen > 0 ? textLen / rawLen : 0;
  out.push({
    section: "Content Quality",
    check_key: "content.text_ratio",
    status: ratio >= 0.1 ? "pass" : ratio >= 0.05 ? "warn" : "fail",
    title: `Text-to-HTML ratio: ${(ratio * 100).toFixed(1)}%`,
    detail:
      ratio >= 0.1
        ? "Visible text density is healthy for AI extraction."
        : ratio >= 0.05
          ? "Low text density — most of the response is markup/script."
          : "Very low text density. AI crawlers will struggle to find substantive content.",
    evidence: { textChars: textLen, htmlBytes: rawLen, ratio },
    priority: ratio >= 0.1 ? 5 : ratio >= 0.05 ? 3 : 2,
  });

  return out;
}
