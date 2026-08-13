// Slop Score — deterministic "does this site look careless?" analyzer.
//
// Design rule for this whole module: we report OBSERVABLE DEFECTS, never
// "this was written by AI". An AI-probability score is unfalsifiable, the
// classifiers are unreliable (they systematically flag non-native English
// writers), and we'd be accusing paying customers. Everything below is
// something the owner can open in a browser, verify in ten seconds, and fix.
//
// Three dimensions, each scanned across every crawled page:
//   content — filler phrasing, no first-party evidence, thin/duplicate pages,
//             placeholders, stale dates, high-confidence misspellings
//   code    — leaked dev artifacts, unrendered template vars, duplicate meta,
//             empty links, deprecated tags, commented-out blocks
//   design  — no viewport, unsized images, placeholder alt text, inline-style
//             density, palette/typography drift across stylesheets
//
// No LLM is involved, so this runs free and can't be taken down by a provider
// quota outage.

import * as cheerio from "cheerio";
import type { Finding } from "../types";

export type SlopDimension = "content" | "code" | "design";

export type SlopIssue = {
  key: string; // stable id, e.g. "content.filler"
  dimension: SlopDimension;
  label: string; // human summary of what's wrong on this page
  fix: string; // what to do about it
  weight: number; // slop points contributed (per page)
  count?: number; // how many instances on this page
  samples?: string[]; // verbatim evidence the owner can grep for
};

export type SlopPage = {
  url: string;
  status: number;
  html: string;
  /** Visible text, already whitespace-collapsed. */
  text: string;
  words: number;
  title: string;
  description: string;
  h1: string;
};

export type SlopStylesheet = { url: string; css: string };

export type PageSlop = {
  url: string;
  words: number;
  issues: SlopIssue[];
  points: number;
};

export type SlopReport = {
  score: number; // 0 = pristine, 100 = maximum slop
  grade: SlopGrade;
  pages: PageSlop[];
  /** Cross-page issues (duplicate meta, near-duplicate bodies, palette drift). */
  siteIssues: SlopIssue[];
  byDimension: Record<SlopDimension, number>;
  totals: { pages: number; issues: number; words: number };
};

export type SlopGrade = "Pristine" | "Clean" | "Some slop" | "Sloppy" | "Slop factory";

// ---------------------------------------------------------------------------
// Signal dictionaries
// ---------------------------------------------------------------------------

// Filler phrasing. These are not "AI words" — they're padding that carries no
// information whichever species typed it. Kept to phrases (not single words)
// so ordinary prose doesn't trip it.
const FILLER_PHRASES = [
  "in today's fast-paced world",
  "in today's digital age",
  "in today's ever-changing",
  "in the ever-evolving",
  "ever-evolving landscape",
  "digital landscape",
  "it's worth noting that",
  "it is worth noting that",
  "it's important to note that",
  "it is important to note that",
  "delve into",
  "delving into",
  "navigate the complexities",
  "navigating the complexities",
  "unlock the power",
  "unlock the potential",
  "harness the power",
  "leverage the power",
  "revolutionize the way",
  "game changer",
  "game-changer",
  "at the end of the day",
  "when it comes to",
  "look no further",
  "in conclusion",
  "a testament to",
  "rich tapestry",
  "vibrant tapestry",
  "seamlessly integrate",
  "seamless integration",
  "robust solution",
  "cutting-edge solution",
  "state-of-the-art solution",
  "elevate your",
  "take your business to the next level",
  "in this article, we'll explore",
  "in this article, we will explore",
  "let's dive in",
  "let's dive into",
  "the world of",
  "plays a crucial role",
  "plays a vital role",
  "paradigm shift",
  "synergy between",
  "best-in-class",
  "one-stop shop",
  "meet and exceed",
  "wide range of solutions",
  "tailored to your needs",
  "whether you're a",
];

// Unfinished-content markers, split by how safe they are to match mid-sentence.
//
// ANYWHERE patterns have no legitimate reading in running prose. STANDALONE
// patterns do — an article about content freshness will say "a feature is
// coming soon", and an AEO guide will say "your brand name in an AI answer".
// Matching those as substrings produces exactly the kind of false accusation
// this module exists to avoid, so they only count when they are the ENTIRE
// text of an element (`<h1>Coming soon</h1>`), never when embedded in a
// sentence. This distinction was added after a dogfood run flagged two
// legitimate blog paragraphs on crawlproof.com itself.
const PLACEHOLDER_ANYWHERE: Array<{ re: RegExp; label: string }> = [
  { re: /lorem ipsum/i, label: "Lorem ipsum filler text" },
  { re: /\bdolor sit amet\b/i, label: "Lorem ipsum filler text" },
  { re: /\binsert (?:your |the )?(?:text|name|content|logo|image) here\b/i, label: "Unreplaced template copy" },
  { re: /\byour (?:company|business|brand|product) name here\b/i, label: "Unreplaced template copy" },
  // Only "[insert …]". Both `[product]` and `[your site]` turned out to be
  // ordinary editorial shorthand in example copy on our own blog ("Does
  // [product] support SSO?", "sign me up at [your site]"), so the bracket rule
  // is narrowed to the one form nobody writes on purpose.
  { re: /\[insert\b[^\]]{0,30}\]/i, label: "Unreplaced [bracketed] placeholder" },
  { re: /\bexample@example\.(?:com|org)\b/i, label: "Example email address" },
  { re: /\b(?:test|foo|asdf)@(?:test|example|foo)\.com\b/i, label: "Test email address" },
  { re: /\b(?:555-?)?555-?01\d{2}\b/, label: "Fake 555 phone number" },
  { re: /\bcreate next app\b/i, label: "Unchanged framework boilerplate" },
  { re: /\bvite \+ (?:react|vue|svelte)\b/i, label: "Unchanged framework boilerplate" },
  { re: /\bwelcome to (?:wordpress|nginx|apache)\b/i, label: "Unchanged server/CMS boilerplate" },
];

const PLACEHOLDER_STANDALONE: Array<{ re: RegExp; label: string }> = [
  { re: /^coming soon[.!…]*$/i, label: '"Coming soon" placeholder' },
  { re: /^under construction[.!…]*$/i, label: '"Under construction" placeholder' },
  { re: /^(?:tbd|to be determined|to be announced|tba)[.!…]*$/i, label: '"TBD" placeholder' },
  { re: /^placeholder(?: text| content| image)?[.!…]*$/i, label: "Explicit placeholder content" },
  { re: /^your (?:company|business|brand|product) name[.!…]*$/i, label: "Unreplaced template copy" },
  { re: /^hello,? world[.!…]*$/i, label: '"Hello world" placeholder' },
  // "Title"/"Description" alone are ordinary table headers and definition-list
  // terms, so only the unambiguous scaffold labels are listed here.
  { re: /^(?:content goes here|body text goes here|your text here|edit this text)[.!…]*$/i, label: "Unreplaced template label" },
];

// Short element texts, used for standalone-placeholder matching. A real
// placeholder occupies a whole heading, cell, or paragraph — never half a
// sentence — so we only consider elements whose entire text is short.
function standaloneTexts($: cheerio.CheerioAPI): string[] {
  const out: string[] = [];
  $(
    "title, h1, h2, h3, h4, h5, h6, p, li, td, th, dd, dt, figcaption, button, a, span, strong, em, blockquote, div",
  ).each((_, el) => {
    const t = $(el).text().replace(/\s+/g, " ").trim();
    if (t && t.length <= 48) out.push(t);
  });
  return out;
}

// Template variables and JS accidents that leaked into rendered text. These
// are the single most embarrassing defect class and trivially fixable.
const LEAKED_VALUE_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\{\{\s*[\w.$[\]'"|\s-]+\s*\}\}/g, label: "Unrendered {{template}} variable" },
  { re: /\$\{\s*[\w.$[\]'"?.\s-]+\s*\}/g, label: "Unrendered ${template} literal" },
  { re: /\[object Object\]/g, label: '"[object Object]" in visible text' },
  { re: /\bundefined\b(?=\s|$|[.,!?)])/g, label: '"undefined" in visible text' },
  { re: /\bNaN\b(?=\s|$|[.,!?)])/g, label: '"NaN" in visible text' },
  { re: /\bnull\b(?=\s|$|[.,!?)])/g, label: '"null" in visible text' },
  { re: /%[sd]\b/g, label: "Unformatted %s / %d printf token" },
  { re: /\bInvalid Date\b/g, label: '"Invalid Date" in visible text' },
];

// Only unambiguous misspellings with no valid alternate reading, so we never
// flag a customer's product name. No dictionary, no brand-name allowlist to
// maintain — that combination is what makes site-wide spellcheck unshippable.
const MISSPELLINGS: Record<string, string> = {
  recieve: "receive",
  recieved: "received",
  seperate: "separate",
  seperately: "separately",
  occured: "occurred",
  occurence: "occurrence",
  definately: "definitely",
  accomodate: "accommodate",
  accomodates: "accommodates",
  buisness: "business",
  sucessful: "successful",
  sucessfully: "successfully",
  enviroment: "environment",
  neccessary: "necessary",
  occassion: "occasion",
  publically: "publicly",
  existance: "existence",
  maintainance: "maintenance",
  priviledge: "privilege",
  recomend: "recommend",
  recomended: "recommended",
  independant: "independent",
  arguement: "argument",
  begining: "beginning",
  beleive: "believe",
  calender: "calendar",
  collegue: "colleague",
  comittee: "committee",
  concious: "conscious",
  embarass: "embarrass",
  goverment: "government",
  garantee: "guarantee",
  garanteed: "guaranteed",
  harrass: "harass",
  immediatly: "immediately",
  knowlege: "knowledge",
  liason: "liaison",
  managment: "management",
  millenium: "millennium",
  noticable: "noticeable",
  occuring: "occurring",
  paticular: "particular",
  perseverence: "perseverance",
  possesion: "possession",
  refered: "referred",
  relevent: "relevant",
  reccommend: "recommend",
  rythm: "rhythm",
  supercede: "supersede",
  tommorow: "tomorrow",
  untill: "until",
  wich: "which",
  writting: "writing",
};

// Hosts that never legitimately appear in a production page — not even as an
// outbound link.
const HARD_DEV_HOST_RE =
  /\b(?:localhost(?::\d+)?|127\.0\.0\.1(?::\d+)?|0\.0\.0\.0(?::\d+)?|staging\.[\w.-]+|dev\.local|[\w-]+\.ngrok(?:-free)?\.(?:io|app|dev))\b/i;

// Preview/PaaS hosts. These DO appear legitimately as outbound links (a link
// aggregator linking someone's Vercel demo, or our own /recent page listing
// "AEO audit for foo.netlify.app"), so they only count when the page loads a
// RESOURCE from them — a script, stylesheet, image, iframe, or form target.
// Both of those false positives showed up in dogfood runs.
const PREVIEW_HOST_RE =
  /\b[\w-]+\.(?:vercel\.app|netlify\.app|onrender\.com|railway\.app|fly\.dev|herokuapp\.com|pages\.dev)\b/i;

// Stock-photo CDNs. Not a defect on its own — only reported when a page has
// stock imagery and no original imagery at all.
const STOCK_IMAGE_RE =
  /\b(?:images\.unsplash\.com|source\.unsplash\.com|images\.pexels\.com|[\w.-]*shutterstock\.com|[\w.-]*istockphoto\.com|[\w.-]*gettyimages\.com|[\w.-]*stock\.adobe\.com|placehold(?:er)?\.(?:co|it|com)|via\.placeholder\.com|picsum\.photos|dummyimage\.com)\b/i;

const PLACEHOLDER_ALT_RE =
  /^(?:image|img|photo|picture|placeholder|alt text|alt|logo|icon|graphic|untitled|screenshot|thumbnail|banner|dsc[_-]?\d+|img[_-]?\d+|image\d*|photo\d*|asset\d*)$/i;

const DEPRECATED_TAGS = ["center", "font", "marquee", "blink", "big", "strike", "tt", "frame", "frameset"];

// ---------------------------------------------------------------------------
// Page preparation
// ---------------------------------------------------------------------------

/** Turn raw HTML into the normalized shape the analyzers consume. */
export function toSlopPage(input: { url: string; status: number; html: string }): SlopPage {
  const $ = cheerio.load(input.html || "");
  const $body = $("body").clone();
  $body.find("script, style, noscript, template, svg").remove();
  const text = $body.text().replace(/\s+/g, " ").trim();
  return {
    url: input.url,
    status: input.status,
    html: input.html || "",
    text,
    words: text ? text.split(/\s+/).length : 0,
    title: $("title").first().text().trim(),
    description: ($("meta[name='description']").attr("content") ?? "").trim(),
    h1: $("h1").first().text().replace(/\s+/g, " ").trim(),
  };
}

function countMatches(haystack: string, re: RegExp): { count: number; samples: string[] } {
  // Caller-supplied regexes are reused across pages, so always work on a
  // fresh copy — a stateful lastIndex would silently skip matches.
  const rx = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
  const samples: string[] = [];
  let count = 0;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(haystack)) !== null) {
    count++;
    if (samples.length < 5) samples.push(m[0].slice(0, 120));
    if (m[0] === "") rx.lastIndex++; // guard against zero-length matches
    if (count > 500) break; // pathological page; the number is already damning
  }
  return { count, samples };
}

/** Visible text with script/style already gone, lowercased for phrase search. */
function fillerHits(text: string): { count: number; samples: string[] } {
  const lower = text.toLowerCase();
  const samples: string[] = [];
  let count = 0;
  for (const phrase of FILLER_PHRASES) {
    let from = 0;
    for (;;) {
      const at = lower.indexOf(phrase, from);
      if (at === -1) break;
      count++;
      if (samples.length < 8) samples.push(phrase);
      from = at + phrase.length;
    }
  }
  return { count, samples };
}

// ---------------------------------------------------------------------------
// Per-page analysis
// ---------------------------------------------------------------------------

export function analyzePage(page: SlopPage): PageSlop {
  const issues: SlopIssue[] = [];
  const $ = cheerio.load(page.html || "");
  const text = page.text;

  // ---- content ------------------------------------------------------------

  // Listing pages (blog indexes, tag archives) are mostly links by design, so
  // the prose-quality checks below don't apply to them — flagging a blog index
  // for having no statistics is noise, not a defect.
  const linkCount = $("a[href]").length;
  const isListing = linkCount >= 12 && page.words / linkCount < 30;

  // Placeholders / unfinished content.
  const blocks = standaloneTexts($);
  const placeholders = [
    ...PLACEHOLDER_ANYWHERE.filter((p) => p.re.test(text)),
    ...PLACEHOLDER_STANDALONE.filter((p) => blocks.some((b) => p.re.test(b))),
  ];
  if (placeholders.length > 0) {
    const labels = Array.from(new Set(placeholders.map((p) => p.label)));
    issues.push({
      key: "content.placeholder",
      dimension: "content",
      label: `Unfinished placeholder content: ${labels.join(", ")}`,
      fix: "Replace the placeholder copy with real content, or unpublish the page until it's written. Placeholder text on a live page tells both readers and answer engines the page is abandoned.",
      weight: 12,
      count: placeholders.length,
      samples: labels,
    });
  }

  // Filler phrasing, measured as density so long pages aren't punished for
  // length alone.
  const filler = fillerHits(text);
  // Both an absolute floor and a density floor must be crossed. One stock
  // phrase in a short page is ordinary writing, not slop — requiring 3+ hits
  // keeps us off well-written pages that happen to say "when it comes to".
  if (page.words >= 120 && filler.count >= 3) {
    const per1k = (filler.count / page.words) * 1000;
    if (per1k >= 1.2) {
      issues.push({
        key: "content.filler",
        dimension: "content",
        label: `${filler.count} filler phrase${filler.count === 1 ? "" : "s"} (${per1k.toFixed(1)} per 1,000 words)`,
        fix: `Cut or rewrite the padding: ${filler.samples
          .slice(0, 4)
          .map((s) => `"${s}"`)
          .join(", ")}. Replace each with a specific claim — a number, a name, or a concrete outcome. Answer engines quote specifics and skip padding.`,
        weight: per1k >= 4 ? 9 : per1k >= 2.4 ? 6 : 3,
        count: filler.count,
        samples: filler.samples,
      });
    }
  }

  // First-party evidence — the strongest single slop signal. A page with no
  // numbers, no names, no quotes and no original imagery has nothing in it
  // that couldn't have been generated without ever seeing the business.
  if (page.words >= 150 && !isListing) {
    const hasStat = /\b\d{1,3}(?:[.,]\d+)?\s?%|\b(?:\$|€|£)\s?\d|\b\d{2,}\s?(?:customers|users|companies|teams|sites|developers|downloads|hours|days|ms|seconds)\b/i.test(text);
    const hasQuote = $("blockquote, q, cite, figcaption").length > 0;
    const hasNamedProof = /\b(?:according to|as reported by|case study|our customer|source:)\b/i.test(text);
    const imgs = $("img[src]").map((_, el) => $(el).attr("src") ?? "").get();
    const hasOriginalImage = imgs.some((src) => src && !STOCK_IMAGE_RE.test(src));
    const hasCode = $("pre, code").length > 0;
    const hasTable = $("table").length > 0;
    const signals = [hasStat, hasQuote, hasNamedProof, hasOriginalImage, hasCode, hasTable].filter(Boolean).length;
    if (signals <= 1) {
      issues.push({
        key: "content.no_first_party_evidence",
        dimension: "content",
        label:
          signals === 0
            ? "No first-party evidence — no numbers, quotes, tables, code, or original images"
            : "Almost no first-party evidence (1 signal of 6)",
        fix: "Add at least two things only you could publish: a real metric with its source, a named customer quote, a comparison table, a screenshot of your own product, or a code sample. This is what separates a page worth citing from a page worth skipping.",
        weight: signals === 0 ? 10 : 5,
        count: signals,
        samples: [
          `stat:${hasStat}`,
          `quote:${hasQuote}`,
          `named-proof:${hasNamedProof}`,
          `original-image:${hasOriginalImage}`,
          `code:${hasCode}`,
          `table:${hasTable}`,
        ],
      });
    }
  }

  // Thin content — a published page with almost nothing on it.
  if (page.status >= 200 && page.status < 300 && page.words < 150 && !isListing) {
    issues.push({
      key: "content.thin",
      dimension: "content",
      label: `Thin page — only ${page.words} visible word${page.words === 1 ? "" : "s"}`,
      fix: "Either expand this to 300+ words of substantive content or remove it from the sitemap and internal nav. Thin pages dilute the crawl budget an answer engine spends on you.",
      weight: page.words < 50 ? 7 : 4,
      count: page.words,
    });
  }

  // Stale dates — a footer stuck two years back reads as abandoned.
  const thisYear = new Date().getUTCFullYear();
  const copyrightYears = Array.from(text.matchAll(/(?:©|\(c\)|copyright)\s*(?:\d{4}\s*[–-]\s*)?(\d{4})/gi)).map((m) =>
    parseInt(m[1]!, 10),
  );
  const newestCopyright = copyrightYears.length > 0 ? Math.max(...copyrightYears) : null;
  if (newestCopyright !== null && newestCopyright < thisYear - 1) {
    issues.push({
      key: "content.stale_copyright",
      dimension: "content",
      label: `Copyright notice says ${newestCopyright} (${thisYear - newestCopyright} years behind)`,
      fix: `Render the year dynamically instead of hardcoding it — e.g. \`© {new Date().getFullYear()} Company\`. A stale copyright is the cheapest possible signal that nobody is minding the site.`,
      weight: 6,
      count: newestCopyright,
    });
  }

  // High-confidence misspellings.
  const misspelled: string[] = [];
  for (const word of text.toLowerCase().match(/[a-z']+/g) ?? []) {
    const fix = MISSPELLINGS[word];
    if (fix && !misspelled.includes(word)) misspelled.push(word);
    if (misspelled.length >= 10) break;
  }
  if (misspelled.length > 0) {
    issues.push({
      key: "content.misspelling",
      dimension: "content",
      label: `${misspelled.length} misspelling${misspelled.length === 1 ? "" : "s"}: ${misspelled
        .slice(0, 5)
        .map((w) => `"${w}" → "${MISSPELLINGS[w]}"`)
        .join(", ")}`,
      fix: "Fix the spellings listed in the evidence. These are unambiguous errors, not style choices — each one is a visible signal that no human proofread the page.",
      weight: misspelled.length >= 4 ? 6 : 3,
      count: misspelled.length,
      samples: misspelled.map((w) => `${w} → ${MISSPELLINGS[w]}`),
    });
  }

  // ---- code ---------------------------------------------------------------

  // Leaked template variables / JS accidents in visible text.
  for (const pat of LEAKED_VALUE_PATTERNS) {
    const { count, samples } = countMatches(text, pat.re);
    if (count > 0) {
      issues.push({
        key: "code.leaked_value",
        dimension: "code",
        label: `${pat.label} rendered on the page (${count}×)`,
        fix: "Trace the template or data binding that produced this and give it a fallback. Visible `undefined`/`{{var}}` text gets indexed verbatim and quoted back by answer engines.",
        weight: 9,
        count,
        samples,
      });
    }
  }

  // Dev/staging hosts leaked into a production page. Only URL-bearing
  // attributes are inspected — a hostname mentioned in body text or JSON-LD is
  // content, not a leak.
  const pageHost = safeHost(page.url);
  const leaked = new Set<string>();
  const collect = (selector: string, attrs: string[], re: RegExp) => {
    $(selector).each((_, el) => {
      for (const attr of attrs) {
        const v = $(el).attr(attr);
        if (!v) continue;
        const host = safeHost(/^https?:\/\//i.test(v) ? v : `http://${v.replace(/^\/+/, "")}`);
        if (!host || (pageHost && host === pageHost)) continue;
        if (re.test(host)) leaked.add(host);
      }
    });
  };
  // Hard dev hosts: anywhere a URL can appear, links included.
  collect("a[href], link[href], area[href], form[action]", ["href", "action"], HARD_DEV_HOST_RE);
  collect(
    "script[src], img[src], iframe[src], source[src], video[src], audio[src], embed[src], object[data]",
    ["src", "data"],
    HARD_DEV_HOST_RE,
  );
  // Preview hosts: resource positions only.
  collect(
    "script[src], img[src], iframe[src], source[src], video[src], audio[src], embed[src], object[data], link[href], form[action]",
    ["src", "data", "href", "action"],
    PREVIEW_HOST_RE,
  );
  if (leaked.size > 0) {
    const hosts = Array.from(leaked);
    issues.push({
      key: "code.dev_artifact_host",
      dimension: "code",
      label: `Dev/staging host${hosts.length === 1 ? "" : "s"} referenced by production markup: ${hosts.slice(0, 3).join(", ")}`,
      fix: "Replace hardcoded localhost/staging/preview hostnames with environment-driven URLs. These break for every visitor and can expose non-production infrastructure.",
      weight: 8,
      count: hosts.length,
      samples: hosts.slice(0, 8),
    });
  }

  // Debug leftovers in inline scripts + TODO markers in comments.
  const inlineScripts = $("script:not([src])")
    .map((_, el) => $(el).html() ?? "")
    .get()
    .join("\n");
  const consoleCalls = countMatches(inlineScripts, /console\.(?:log|debug|warn|dir|table)\s*\(/g);
  if (consoleCalls.count > 0) {
    issues.push({
      key: "code.console_left_in",
      dimension: "code",
      label: `${consoleCalls.count} console.* call${consoleCalls.count === 1 ? "" : "s"} left in inline script`,
      fix: "Strip debug logging from shipped markup (a build-step `drop_console`, or just delete it). It leaks internal state and signals unreviewed code.",
      weight: 3,
      count: consoleCalls.count,
    });
  }

  const comments = page.html.match(/<!--[\s\S]*?-->/g) ?? [];
  const todoComments = comments.filter((c) => /\b(?:TODO|FIXME|XXX|HACK|BUG|WIP)\b/.test(c));
  if (todoComments.length > 0) {
    issues.push({
      key: "code.todo_comment",
      dimension: "code",
      label: `${todoComments.length} TODO/FIXME comment${todoComments.length === 1 ? "" : "s"} shipped in HTML`,
      fix: "Resolve or delete these before shipping, and strip HTML comments in your production build. They're publicly readable notes about your own unfinished work.",
      weight: 3,
      count: todoComments.length,
      samples: todoComments.slice(0, 3).map((c) => c.replace(/\s+/g, " ").slice(0, 120)),
    });
  }

  // Large commented-out markup blocks — dead code left in the page.
  const bigComments = comments.filter((c) => c.length > 500 && /<\/?\w+[\s>]/.test(c));
  if (bigComments.length > 0) {
    const bytes = bigComments.reduce((n, c) => n + c.length, 0);
    issues.push({
      key: "code.commented_out_markup",
      dimension: "code",
      label: `${bigComments.length} large commented-out markup block${bigComments.length === 1 ? "" : "s"} (${(bytes / 1024).toFixed(1)} KB)`,
      fix: "Delete dead markup instead of commenting it out — version control already remembers it. Every visitor and crawler downloads these bytes.",
      weight: 2,
      count: bigComments.length,
    });
  }

  // Empty / dead-end interactive elements.
  const emptyLinks = $("a[href]").filter((_, el) => {
    const $el = $(el);
    const label = $el.text().replace(/\s+/g, " ").trim();
    const alt = $el.find("img[alt]").attr("alt")?.trim();
    return !label && !alt && !$el.attr("aria-label") && !$el.attr("title");
  }).length;
  const hashLinks = $("a").filter((_, el) => {
    const href = ($(el).attr("href") ?? "").trim();
    return href === "#" || href === "" || /^javascript:\s*(?:void\(0\)|;)?$/i.test(href);
  }).length;
  if (emptyLinks + hashLinks > 2) {
    const parts = [
      emptyLinks > 0 ? `${emptyLinks} unlabelled link${emptyLinks === 1 ? "" : "s"}` : null,
      hashLinks > 0 ? `${hashLinks} placeholder href${hashLinks === 1 ? "" : "s"} (# / javascript:void)` : null,
    ].filter(Boolean);
    issues.push({
      key: "code.dead_links",
      dimension: "code",
      label: parts.join(" and "),
      fix: 'Give every link real text or an aria-label, and point it at a real URL. `href="#"` navigation is invisible to crawlers and unusable with a keyboard or screen reader.',
      weight: 4,
      count: emptyLinks + hashLinks,
    });
  }

  // Deprecated tags — a reliable marker of copy-pasted decade-old markup.
  const deprecated = DEPRECATED_TAGS.filter((t) => $(t).length > 0);
  if (deprecated.length > 0) {
    issues.push({
      key: "code.deprecated_tags",
      dimension: "code",
      label: `Deprecated HTML tags in use: ${deprecated.map((t) => `<${t}>`).join(", ")}`,
      fix: "Replace these with CSS equivalents. They've been non-conforming for over a decade and their rendering is not guaranteed.",
      weight: 3,
      count: deprecated.length,
      samples: deprecated,
    });
  }

  // ---- design -------------------------------------------------------------

  // No viewport meta — the page is unusable on a phone.
  if (!$("meta[name='viewport']").attr("content")) {
    issues.push({
      key: "design.no_viewport",
      dimension: "design",
      label: "No viewport meta tag — page won't scale on mobile",
      fix: 'Add `<meta name="viewport" content="width=device-width, initial-scale=1" />`. Without it mobile browsers render at desktop width and zoom out.',
      weight: 7,
    });
  }

  // Images with no intrinsic size — the classic layout-shift jank.
  const imgs = $("img");
  const unsized = imgs.filter((_, el) => {
    const $el = $(el);
    if ($el.attr("width") && $el.attr("height")) return false;
    const style = $el.attr("style") ?? "";
    return !(/\bwidth\s*:/.test(style) && /\bheight\s*:/.test(style));
  }).length;
  if (imgs.length > 0 && unsized / imgs.length > 0.5 && unsized >= 3) {
    issues.push({
      key: "design.unsized_images",
      dimension: "design",
      label: `${unsized} of ${imgs.length} images have no width/height — causes layout shift`,
      fix: "Set explicit `width` and `height` (or an aspect-ratio box) on every image so the browser can reserve space before the file loads. This is the most common cause of content jumping as a page renders.",
      weight: 4,
      count: unsized,
    });
  }

  // Placeholder alt text — worse than empty alt, because it looks handled.
  const placeholderAlt = imgs
    .map((_, el) => ($(el).attr("alt") ?? "").trim())
    .get()
    .filter((a) => a.length > 0 && PLACEHOLDER_ALT_RE.test(a));
  if (placeholderAlt.length > 0) {
    issues.push({
      key: "design.placeholder_alt",
      dimension: "design",
      label: `${placeholderAlt.length} image${placeholderAlt.length === 1 ? "" : "s"} with placeholder alt text: ${Array.from(new Set(placeholderAlt)).slice(0, 4).map((a) => `"${a}"`).join(", ")}`,
      fix: 'Describe what each image actually shows ("Dashboard showing 42% cost reduction"), or use `alt=""` if it\'s decorative. Generic alt text passes automated checks while helping nobody.',
      weight: 4,
      count: placeholderAlt.length,
      samples: Array.from(new Set(placeholderAlt)).slice(0, 8),
    });
  }

  // Stock-only imagery.
  const imgSrcs = imgs.map((_, el) => $(el).attr("src") ?? "").get().filter(Boolean);
  if (imgSrcs.length >= 2) {
    const stock = imgSrcs.filter((s) => STOCK_IMAGE_RE.test(s));
    if (stock.length === imgSrcs.length) {
      issues.push({
        key: "design.stock_only_imagery",
        dimension: "design",
        label: `All ${imgSrcs.length} images are stock or placeholder services`,
        fix: "Add at least one original image — a product screenshot, your team, your actual workspace. Stock-only imagery is interchangeable with every competitor's page.",
        weight: 5,
        count: stock.length,
        samples: stock.slice(0, 4),
      });
    }
  }

  // Inline-style density — styling applied ad hoc instead of systematically.
  const inlineStyled = $("[style]").length;
  const elements = $("*").length;
  if (elements > 50 && inlineStyled / elements > 0.25 && inlineStyled >= 20) {
    issues.push({
      key: "design.inline_style_density",
      dimension: "design",
      label: `${inlineStyled} of ${elements} elements carry inline styles (${Math.round((inlineStyled / elements) * 100)}%)`,
      fix: "Move repeated inline styles into classes or design tokens. Heavy inline styling means visual changes have to be made element-by-element, which is how sites drift out of visual consistency.",
      weight: 3,
      count: inlineStyled,
    });
  }

  const points = issues.reduce((n, i) => n + i.weight, 0);
  return { url: page.url, words: page.words, issues, points };
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Cross-page analysis
// ---------------------------------------------------------------------------

/**
 * 5-word shingle set, capped so a huge page can't blow up memory.
 *
 * Exported so the autoblog pre-publish gate (lib/lx/qualityGate.ts) can run
 * the same near-duplicate comparison against previously generated articles.
 * Keeping one implementation means a draft we accept is scored by exactly the
 * measure the site audit would later use against it.
 */
export function shingles(text: string): Set<string> {
  const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
  const out = new Set<string>();
  for (let i = 0; i + 5 <= words.length && out.size < 4000; i++) {
    out.add(words.slice(i, i + 5).join(" "));
  }
  return out;
}

/** Shingle-set overlap, 0–1. Exported alongside `shingles` for the autoblog gate. */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let shared = 0;
  for (const s of small) if (large.has(s)) shared++;
  return shared / (a.size + b.size - shared);
}

export function analyzeSite(pages: SlopPage[], stylesheets: SlopStylesheet[] = []): SlopIssue[] {
  const out: SlopIssue[] = [];
  const ok = pages.filter((p) => p.status >= 200 && p.status < 300);

  // Duplicate titles / descriptions — templated metadata nobody filled in.
  for (const [field, get] of [
    ["title", (p: SlopPage) => p.title],
    ["meta description", (p: SlopPage) => p.description],
  ] as const) {
    const groups = new Map<string, string[]>();
    for (const p of ok) {
      const v = get(p);
      if (!v) continue;
      const key = v.toLowerCase();
      groups.set(key, [...(groups.get(key) ?? []), p.url]);
    }
    const dupes = Array.from(groups.entries()).filter(([, urls]) => urls.length > 1);
    if (dupes.length > 0) {
      const affected = dupes.reduce((n, [, urls]) => n + urls.length, 0);
      out.push({
        key: `code.duplicate_${field === "title" ? "title" : "description"}`,
        dimension: "code",
        label: `${affected} pages share ${dupes.length} duplicate ${field}${dupes.length === 1 ? "" : "s"}`,
        fix: `Give every page a unique ${field} describing that page specifically. Duplicates tell an answer engine the pages are interchangeable, so it picks one and drops the rest.`,
        weight: Math.min(10, 2 + affected),
        count: affected,
        samples: dupes.slice(0, 4).map(([v, urls]) => `"${v.slice(0, 60)}" × ${urls.length} (${urls[0]})`),
      });
    }
  }

  // Missing titles / H1s across the property.
  const noTitle = ok.filter((p) => !p.title);
  if (noTitle.length > 0) {
    out.push({
      key: "code.missing_title",
      dimension: "code",
      label: `${noTitle.length} page${noTitle.length === 1 ? "" : "s"} with no <title>`,
      fix: "Every page needs a unique <title>. It's the single most-quoted piece of metadata in AI answers and search results.",
      weight: Math.min(10, 3 + noTitle.length),
      count: noTitle.length,
      samples: noTitle.slice(0, 5).map((p) => p.url),
    });
  }
  const noH1 = ok.filter((p) => !p.h1);
  if (noH1.length > 0) {
    out.push({
      key: "content.missing_h1",
      dimension: "content",
      label: `${noH1.length} page${noH1.length === 1 ? "" : "s"} with no <h1>`,
      fix: "Add one H1 per page stating what the page is about. Answer engines use it as the page's headline claim.",
      weight: Math.min(8, 2 + noH1.length),
      count: noH1.length,
      samples: noH1.slice(0, 5).map((p) => p.url),
    });
  }

  // Near-duplicate bodies — the signature of mass-generated pages.
  const substantial = ok.filter((p) => p.words >= 200).slice(0, 50);
  const shingled = substantial.map((p) => ({ url: p.url, set: shingles(p.text) }));
  const pairs: Array<{ a: string; b: string; sim: number }> = [];
  for (let i = 0; i < shingled.length; i++) {
    for (let j = i + 1; j < shingled.length; j++) {
      const sim = jaccard(shingled[i]!.set, shingled[j]!.set);
      if (sim >= 0.7) pairs.push({ a: shingled[i]!.url, b: shingled[j]!.url, sim });
    }
  }
  if (pairs.length > 0) {
    pairs.sort((x, y) => y.sim - x.sim);
    const affected = new Set(pairs.flatMap((p) => [p.a, p.b]));
    out.push({
      key: "content.near_duplicate",
      dimension: "content",
      label: `${affected.size} pages are near-duplicates of each other (${pairs.length} pair${pairs.length === 1 ? "" : "s"} ≥70% identical)`,
      fix: "Consolidate these into one strong page and redirect the rest, or rewrite each to cover something genuinely different. Near-duplicate pages are the clearest fingerprint of scaled content, and they compete with each other instead of ranking.",
      weight: Math.min(14, 4 + affected.size),
      count: affected.size,
      samples: pairs.slice(0, 5).map((p) => `${(p.sim * 100).toFixed(0)}% — ${p.a} ≈ ${p.b}`),
    });
  }

  // Boilerplate intros — same opening sentence across many pages.
  const intros = new Map<string, string[]>();
  for (const p of ok) {
    if (p.words < 80) continue;
    const intro = p.text.slice(0, 120).toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
    if (intro.length < 40) continue;
    intros.set(intro, [...(intros.get(intro) ?? []), p.url]);
  }
  const repeatedIntro = Array.from(intros.entries()).filter(([, urls]) => urls.length >= 3);
  if (repeatedIntro.length > 0) {
    const affected = repeatedIntro.reduce((n, [, urls]) => n + urls.length, 0);
    out.push({
      key: "content.boilerplate_intro",
      dimension: "content",
      label: `${affected} pages open with an identical first sentence`,
      fix: "Write a page-specific opening for each. A shared intro means the first thing every crawler reads is the same, so nothing distinguishes the pages.",
      weight: Math.min(8, 2 + repeatedIntro.length * 2),
      count: affected,
      samples: repeatedIntro.slice(0, 3).map(([intro, urls]) => `"${intro.slice(0, 60)}…" × ${urls.length}`),
    });
  }

  // ---- design system drift (needs stylesheets) ----------------------------
  if (stylesheets.length > 0) {
    const css = stylesheets.map((s) => s.css).join("\n");

    // Palette sprawl: dozens of one-off hex values means colors are being
    // eyeballed per component instead of taken from tokens.
    //
    // Custom-property declarations are stripped first, because a design system
    // legitimately DEFINES a full ramp there (Tailwind's theme emits ~100 hex
    // steps whether or not you use them). Counting those punished sites for
    // having tokens, which is backwards — after stripping, a high count means
    // colors are being written ad hoc in real declarations.
    const adHocCss = css.replace(/--[\w-]+\s*:[^;}]*[;}]/g, "");
    const hexes = new Set(
      (adHocCss.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).map((h) => normalizeHex(h)).filter(Boolean) as string[],
    );
    if (hexes.size > 60) {
      out.push({
        key: "design.palette_sprawl",
        dimension: "design",
        label: `${hexes.size} distinct hex colors across ${stylesheets.length} stylesheet${stylesheets.length === 1 ? "" : "s"}`,
        fix: "Consolidate to a token palette (CSS custom properties) of roughly 10–20 values with defined roles. Dozens of near-identical one-off colors is why a site looks subtly inconsistent page to page.",
        weight: hexes.size > 120 ? 5 : 3,
        count: hexes.size,
        samples: Array.from(hexes).slice(0, 10),
      });
    }

    // Typography sprawl.
    const families = new Set(
      (css.match(/font-family\s*:\s*([^;}]+)/gi) ?? []).map((d) =>
        d.replace(/font-family\s*:\s*/i, "").split(",")[0]!.trim().replace(/['"]/g, "").toLowerCase(),
      ),
    );
    families.delete("inherit");
    families.delete("");
    if (families.size > 6) {
      out.push({
        key: "design.font_sprawl",
        dimension: "design",
        label: `${families.size} distinct font families declared`,
        fix: "Cut to two or three typefaces (one display, one text, optionally one mono). Every extra family is another web font to download and another way the page looks unplanned.",
        weight: 3,
        count: families.size,
        samples: Array.from(families).slice(0, 10),
      });
    }

    // !important density — specificity wars, the CSS smell of accumulated
    // patch-on-patch fixes.
    const importants = (css.match(/!\s*important/gi) ?? []).length;
    const rules = (css.match(/\{/g) ?? []).length || 1;
    if (importants >= 25 && importants / rules > 0.08) {
      out.push({
        key: "design.important_overuse",
        dimension: "design",
        label: `${importants} \`!important\` declarations (${((importants / rules) * 100).toFixed(0)}% of rules)`,
        fix: "Untangle the specificity instead of overriding it. Heavy `!important` use means each new style change fights the last one, and it's why small visual fixes start breaking unrelated pages.",
        weight: 3,
        count: importants,
      });
    }
  }

  return out;
}

function normalizeHex(h: string): string | null {
  const v = h.slice(1).toLowerCase();
  if (v.length === 3) return `#${v[0]}${v[0]}${v[1]}${v[1]}${v[2]}${v[2]}`;
  if (v.length === 6) return `#${v}`;
  if (v.length === 8) return `#${v.slice(0, 6)}`; // ignore alpha
  return null;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

// Slop points are converted to a 0–100 score with a saturating curve: the
// first few defects move the number a lot, and a genuinely broken site pins
// near 100 without a single check being able to dominate.
export function slopScore(pages: PageSlop[], siteIssues: SlopIssue[]): number {
  const pageCount = Math.max(1, pages.length);
  const perPage = pages.reduce((n, p) => n + p.points, 0) / pageCount;
  const sitePoints = siteIssues.reduce((n, i) => n + i.weight, 0);
  // ~25 points/page or ~40 site-wide points lands around 60 ("Sloppy").
  const raw = perPage / 25 + sitePoints / 40;
  return Math.round(100 * (1 - Math.exp(-1.1 * raw)));
}

export function slopGrade(score: number): SlopGrade {
  if (score <= 8) return "Pristine";
  if (score <= 25) return "Clean";
  if (score <= 50) return "Some slop";
  if (score <= 75) return "Sloppy";
  return "Slop factory";
}

export function buildSlopReport(pages: SlopPage[], stylesheets: SlopStylesheet[] = []): SlopReport {
  const analyzed = pages.map(analyzePage);
  const siteIssues = analyzeSite(pages, stylesheets);
  const score = slopScore(analyzed, siteIssues);
  const byDimension: Record<SlopDimension, number> = { content: 0, code: 0, design: 0 };
  for (const i of [...analyzed.flatMap((p) => p.issues), ...siteIssues]) {
    byDimension[i.dimension] += i.weight;
  }
  return {
    score,
    grade: slopGrade(score),
    pages: analyzed.sort((a, b) => b.points - a.points),
    siteIssues: siteIssues.sort((a, b) => b.weight - a.weight),
    byDimension,
    totals: {
      pages: pages.length,
      issues: analyzed.reduce((n, p) => n + p.issues.length, 0) + siteIssues.length,
      words: pages.reduce((n, p) => n + p.words, 0),
    },
  };
}

// ---------------------------------------------------------------------------
// Findings + markdown
// ---------------------------------------------------------------------------

export const SLOP_SECTION = "Slop Score";

const DIMENSION_LABEL: Record<SlopDimension, string> = {
  content: "Content",
  code: "Code",
  design: "Design",
};

/** Per-page recommendation findings, worst pages first. */
export function slopFindings(report: SlopReport, maxPages = 50): Finding[] {
  const out: Finding[] = [];

  // Headline: the shareable number. Excluded from the AEO score in engine.ts
  // so it doesn't double-count the sub-checks it summarizes.
  out.push({
    section: SLOP_SECTION,
    check_key: "slop.score",
    status: report.score <= 25 ? "pass" : report.score <= 50 ? "warn" : "fail",
    title: `Slop Score: ${report.score}/100 — ${report.grade}`,
    detail:
      `Scanned ${report.totals.pages} page${report.totals.pages === 1 ? "" : "s"} (${report.totals.words.toLocaleString()} words) and found ${report.totals.issues} issue${report.totals.issues === 1 ? "" : "s"}.\n\n` +
      `Slop points by dimension — content ${report.byDimension.content}, code ${report.byDimension.code}, design ${report.byDimension.design}.\n\n` +
      `0 is pristine, 100 is maximum slop. This measures observable defects — placeholder text, duplicate pages, leaked template variables, missing evidence, stale dates — not whether anything was written by AI.`,
    evidence: {
      score: report.score,
      grade: report.grade,
      byDimension: report.byDimension,
      totals: report.totals,
    },
    priority: 5,
  });

  // Site-wide issues.
  for (const issue of report.siteIssues) {
    out.push({
      section: SLOP_SECTION,
      check_key: `slop.site.${issue.key}`,
      status: issue.weight >= 8 ? "fail" : "warn",
      title: `${DIMENSION_LABEL[issue.dimension]} — ${issue.label}`,
      detail: issue.fix,
      evidence: { dimension: issue.dimension, weight: issue.weight, count: issue.count, samples: issue.samples },
      priority: issue.weight >= 10 ? 2 : issue.weight >= 5 ? 3 : 4,
    });
  }

  // Systemic rollups. When the same defect appears on many pages it's a
  // template bug, not 30 content bugs — leading with "fix your post template"
  // is both better advice and a shorter to-do list. These are informational:
  // the per-page findings below still carry the detail, and slop-engine.ts
  // leaves rollups out of the score so nothing is counted twice.
  const byKey = new Map<string, { issue: SlopIssue; urls: string[] }>();
  for (const p of report.pages) {
    for (const i of p.issues) {
      const entry = byKey.get(i.key);
      if (entry) entry.urls.push(p.url);
      else byKey.set(i.key, { issue: i, urls: [p.url] });
    }
  }
  for (const { issue, urls } of Array.from(byKey.values()).sort((a, b) => b.urls.length - a.urls.length)) {
    if (urls.length < 5) continue;
    out.push({
      section: SLOP_SECTION,
      check_key: `slop.systemic.${issue.key}`,
      status: urls.length >= 10 ? "fail" : "warn",
      title: `${DIMENSION_LABEL[issue.dimension]} — ${urls.length} pages share one defect: ${issue.label.replace(/^\d+ (?:of \d+ )?/, "")}`,
      detail:
        `This appears on ${urls.length} of the ${report.totals.pages} pages crawled, which means it lives in a shared template or component rather than in the content. Fix it once there and every page is fixed.\n\n${issue.fix}`,
      evidence: {
        dimension: issue.dimension,
        issueKey: issue.key,
        pages: urls.length,
        systemic: true,
        urls: urls.slice(0, 25),
      },
      priority: urls.length >= 10 ? 2 : 3,
    });
  }

  // One finding per page, so each is independently fixable (and routable to a
  // GitHub auto-fix PR, which takes a single finding at a time).
  for (const page of report.pages.slice(0, maxPages)) {
    if (page.issues.length === 0) continue;
    out.push({
      section: SLOP_SECTION,
      check_key: `slop.page.${slugForUrl(page.url)}`,
      status: page.points >= 15 ? "fail" : "warn",
      title: `${pathOf(page.url)} — ${page.issues.length} issue${page.issues.length === 1 ? "" : "s"} (${page.points} slop points)`,
      detail: page.issues
        .map((i) => `**${DIMENSION_LABEL[i.dimension]}: ${i.label}**\n${i.fix}`)
        .join("\n\n"),
      evidence: {
        url: page.url,
        words: page.words,
        points: page.points,
        issues: page.issues.map((i) => ({
          key: i.key,
          dimension: i.dimension,
          label: i.label,
          fix: i.fix,
          count: i.count,
          samples: i.samples,
        })),
      },
      priority: page.points >= 25 ? 2 : page.points >= 12 ? 3 : 4,
    });
  }

  return out;
}

function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + u.search || "/";
  } catch {
    return url;
  }
}

function slugForUrl(url: string): string {
  const p = pathOf(url).replace(/^\/+|\/+$/g, "");
  return (p || "home").toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 60);
}

export function slopMarkdown(input: {
  targetUrl: string;
  report: SlopReport;
  crawled: number;
  capped: boolean;
  durationMs: number;
  maxPages: number;
}): string {
  const { targetUrl, report, crawled, capped, durationMs, maxPages } = input;
  const lines: string[] = [];
  lines.push(`# Slop Score — ${targetUrl}`);
  lines.push("");
  lines.push(`## ${report.score}/100 — ${report.grade}`);
  lines.push("");
  lines.push(
    `0 is pristine, 100 is maximum slop. This is a measure of **observable defects** — placeholder copy, duplicate pages, leaked template variables, missing first-party evidence, stale dates, unlabelled links, design drift. It does **not** estimate whether anything was written by AI.`,
  );
  lines.push("");
  lines.push(`| Metric | Value |`);
  lines.push(`| --- | --- |`);
  lines.push(`| Pages crawled | ${crawled}${capped ? ` (capped at ${maxPages})` : ""} |`);
  lines.push(`| Words analyzed | ${report.totals.words.toLocaleString()} |`);
  lines.push(`| Issues found | ${report.totals.issues} |`);
  lines.push(`| Content slop points | ${report.byDimension.content} |`);
  lines.push(`| Code slop points | ${report.byDimension.code} |`);
  lines.push(`| Design slop points | ${report.byDimension.design} |`);
  lines.push(`| Duration | ${(durationMs / 1000).toFixed(1)}s |`);
  lines.push("");

  if (report.siteIssues.length > 0) {
    lines.push(`## Site-wide issues`);
    lines.push("");
    for (const i of report.siteIssues) {
      lines.push(`### ${DIMENSION_LABEL[i.dimension]} — ${i.label}`);
      lines.push("");
      lines.push(i.fix);
      if (i.samples?.length) {
        lines.push("");
        lines.push(i.samples.map((s) => `- \`${s}\``).join("\n"));
      }
      lines.push("");
    }
  }

  const withIssues = report.pages.filter((p) => p.issues.length > 0);
  if (withIssues.length === 0) {
    lines.push(`## Per-page findings`);
    lines.push("");
    lines.push(`No page-level slop found across ${crawled} pages. Nice work.`);
    lines.push("");
  } else {
    lines.push(`## Per-page findings (${withIssues.length} page${withIssues.length === 1 ? "" : "s"}, worst first)`);
    lines.push("");
    lines.push(`| Page | Slop points | Issues |`);
    lines.push(`| --- | ---: | ---: |`);
    for (const p of withIssues.slice(0, maxPages)) {
      lines.push(`| ${pathOf(p.url)} | ${p.points} | ${p.issues.length} |`);
    }
    lines.push("");
    for (const p of withIssues.slice(0, maxPages)) {
      lines.push(`### ${pathOf(p.url)}`);
      lines.push("");
      lines.push(`${p.url} — ${p.words.toLocaleString()} words, ${p.points} slop points`);
      lines.push("");
      for (const i of p.issues) {
        lines.push(`- **${DIMENSION_LABEL[i.dimension]}: ${i.label}**`);
        lines.push(`  ${i.fix}`);
        if (i.samples?.length) {
          lines.push(`  Evidence: ${i.samples.slice(0, 5).map((s) => `\`${s}\``).join(", ")}`);
        }
      }
      lines.push("");
    }
  }

  const clean = report.pages.filter((p) => p.issues.length === 0);
  if (clean.length > 0) {
    lines.push(`## Clean pages (${clean.length})`);
    lines.push("");
    lines.push(clean.slice(0, 50).map((p) => `- ${pathOf(p.url)}`).join("\n"));
    lines.push("");
  }

  return lines.join("\n");
}
