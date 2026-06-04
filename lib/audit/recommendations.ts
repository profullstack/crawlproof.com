import type { Finding } from "./types";

// Map check_key -> structured recommendation copy.
const RECS: Record<string, { title: string; how: string }> = {
  "homepage.h1": {
    title: "Add a single, focused H1 to the homepage",
    how: "One `<h1>` per page. Write it as 'We help [audience] [do thing].' so an LLM can quote it verbatim.",
  },
  "homepage.title": {
    title: "Set a meaningful `<title>`",
    how:
      "30–60 chars. Lead with the brand or product, then the value prop.\n\n" +
      "```html\n<title>CrawlProof — AEO audits for AI crawlers</title>\n```",
  },
  "homepage.description": {
    title: "Add a meta description",
    how:
      "50–160 chars. Repeat your core value prop in plain language; this often becomes the AI snippet.\n\n" +
      "```html\n<meta name=\"description\" content=\"CrawlProof shows you exactly how AI crawlers see your site, then tells you what to fix.\" />\n```",
  },
  "homepage.canonical": {
    title: "Add a canonical link",
    how:
      "Prevents dup-content drift and tells AI crawlers which URL is authoritative.\n\n" +
      "```html\n<link rel=\"canonical\" href=\"https://yoursite.com/\" />\n```",
  },
  "homepage.og": {
    title: "Complete Open Graph tags",
    how:
      "AI bots use OG for fast disambiguation. Add all four:\n\n" +
      "```html\n" +
      "<meta property=\"og:title\" content=\"Your Page Title\" />\n" +
      "<meta property=\"og:description\" content=\"50–160 char description of this page.\" />\n" +
      "<meta property=\"og:image\" content=\"https://yoursite.com/og-image.jpg\" />\n" +
      "<meta property=\"og:url\" content=\"https://yoursite.com/\" />\n" +
      "<meta property=\"og:type\" content=\"website\" />\n" +
      "<meta property=\"og:site_name\" content=\"YourSite\" />\n" +
      "```",
  },
  "homepage.twitter": {
    title: "Add Twitter Card meta tags",
    how:
      "Used by social platforms and AI agents for richer previews.\n\n" +
      "```html\n" +
      "<meta name=\"twitter:card\" content=\"summary_large_image\" />\n" +
      "<meta name=\"twitter:title\" content=\"Your Page Title\" />\n" +
      "<meta name=\"twitter:description\" content=\"50–160 char description.\" />\n" +
      "<meta name=\"twitter:image\" content=\"https://yoursite.com/og-image.jpg\" />\n" +
      "```",
  },
  "homepage.lang": {
    title: "Declare a language on the <html> tag",
    how:
      "Helps AI engines serve localized results and confirms content language.\n\n" +
      "```html\n<html lang=\"en\">\n```",
  },
  "homepage.load_time": {
    title: "Speed up homepage rendering",
    how: "AI crawlers commonly time out around 3s. Cache the HTML, ship less JS for the first paint, and pre-render the hero section server-side.",
  },
  "homepage.word_count": {
    title: "Add more substantive homepage content",
    how: "AI models need 300+ words of visible body text to summarize and recommend a site. Add a value-prop paragraph, a short FAQ, and a 'how it works' section.",
  },
  "homepage.heading_structure": {
    title: "Add structured headings",
    how: "Use h2 for each section and h3 for sub-points. AI uses these to outline and chunk the page.",
  },
  "homepage.internal_links": {
    title: "Add internal navigation links",
    how: "Top nav + footer with links to /pricing, /docs, /about, /contact gives AI crawlers an entry point to the rest of the site.",
  },
  "homepage.js_rendered": {
    title: "Server-render critical homepage content",
    how: "Move the headline, sub-headline, pricing summary, and CTA into server-rendered HTML. Most LLM bots do not execute JS.",
  },
  "homepage.alt_text": {
    title: "Add alt text to all meaningful images",
    how: "Decorative-only images can use empty alt='', but logos, screenshots, and product images need descriptive alt.",
  },
  "schema.any": {
    title: "Add JSON-LD structured data",
    how: "Start with Organization on the root layout and SoftwareApplication or Product on /pricing. Add FAQPage on any FAQ section.",
  },
  "schema.invalid": {
    title: "Fix invalid JSON-LD",
    how: "Use search.google.com/test/rich-results to validate. Remove blocks that fail to parse.",
  },
  "schema.org": {
    title: "Add Organization JSON-LD",
    how: "Include name, url, logo, sameAs (your social profiles). LLMs use this to resolve your brand entity.",
  },
  "schema.web": {
    title: "Add WebSite JSON-LD",
    how: "Helps engines understand the root site and enables sitelinks-search-box features.",
  },
  "schema.product": {
    title: "Add Product / SoftwareApplication JSON-LD",
    how: "On /pricing and feature pages — include offers, name, applicationCategory.",
  },
  "schema.faq": {
    title: "Add FAQPage JSON-LD",
    how: "Wrap your homepage FAQ in FAQPage JSON-LD; it routinely lifts AI answer inclusion.",
  },
  "robots.exists": {
    title: "Create a robots.txt",
    how: "Even a minimal robots.txt is better than none. Always reference your Sitemap and explicitly address AI bots.",
  },
  "robots.sitemap_ref": {
    title: "Reference your sitemap in robots.txt",
    how: "Add `Sitemap: https://yoursite.com/sitemap.xml` so crawlers don't have to guess.",
  },
  "sitemap.exists": {
    title: "Publish a sitemap.xml",
    how: "Generate /sitemap.xml automatically (Next.js: app/sitemap.ts). Include every canonical URL.",
  },
  "sitemap.empty": {
    title: "Populate your sitemap with canonical URLs",
    how: "The sitemap must list `<loc>` entries — empty sitemaps are worse than none.",
  },
  "llms_txt": {
    title: "Add /llms.txt",
    how: "A short Markdown-flavored summary at the root. Include your H1, value prop, top 5–10 links, and pricing summary.",
  },
  "skill_md": {
    title: "Add /skill.md",
    how: "Describe what an agent can do with your site (e.g., 'Search docs', 'Look up pricing'). Useful for agentic flows.",
  },
  "security_txt": {
    title: "Publish /.well-known/security.txt",
    how:
      "A security contact builds trust with crawlers and researchers. Minimal example:\n\n" +
      "```\n" +
      "Contact: mailto:security@yourdomain.com\n" +
      "Expires: 2027-01-01T00:00:00.000Z\n" +
      "Preferred-Languages: en\n" +
      "```",
  },
  "schema.json_ld_organization": {
    title: "Add Schema.org Organization JSON-LD",
    how:
      "Helps AI engines resolve your brand entity:\n\n" +
      "```html\n" +
      "<script type=\"application/ld+json\">\n" +
      "{\n" +
      "  \"@context\": \"https://schema.org\",\n" +
      "  \"@type\": \"Organization\",\n" +
      "  \"name\": \"Your Company\",\n" +
      "  \"url\": \"https://yoursite.com\",\n" +
      "  \"logo\": \"https://yoursite.com/logo.png\",\n" +
      "  \"description\": \"What you do, in one sentence.\",\n" +
      "  \"sameAs\": [\n" +
      "    \"https://twitter.com/yourhandle\",\n" +
      "    \"https://linkedin.com/company/yourcompany\"\n" +
      "  ]\n" +
      "}\n" +
      "</script>\n" +
      "```",
  },
  "positioning.who": {
    title: "Make your About/Team page reachable",
    how: "Add a top-nav or footer link to /about or /team so LLMs can identify the entity behind the site.",
  },
  "positioning.what": {
    title: "Rewrite the homepage H1 to be self-evident",
    how: "Replace clever copy with literal copy. 'We help X do Y' beats 'Reimagine Y'.",
  },
  "positioning.audience": {
    title: "State your audience explicitly",
    how: "Use phrases like 'Built for B2B SaaS marketing teams' on the homepage and About page.",
  },
  "positioning.pricing": {
    title: "Add a /pricing page",
    how: "Even contact-us pricing benefits from a /pricing page that LLMs can link to in answers.",
  },
  "positioning.cta": {
    title: "Add a discoverable CTA",
    how: "Place 'Contact sales' or 'Start free' in the top-right of the nav. LLMs cite the visible label.",
  },

  // --- Meta / Discoverability ---
  "meta.robots_noindex": {
    title: "Remove noindex from the homepage",
    how: 'The homepage must be indexable. Drop the `noindex` from `<meta name="robots">` or the response `X-Robots-Tag`.',
  },
  "meta.x_robots_noindex": {
    title: "Remove X-Robots-Tag: noindex on the homepage",
    how: "The response header is telling crawlers not to index the page. Drop the header or limit it to admin/preview routes.",
  },
  "meta.hreflang": {
    title: "Add hreflang x-default",
    how: 'Declare `<link rel="alternate" hreflang="x-default" href="...">` so engines can fall back when a user\'s locale isn\'t in your list.',
  },
  "meta.favicon": {
    title: "Add a favicon",
    how: 'Add `<link rel="icon" href="/favicon.ico">` and an `apple-touch-icon` so AI citation cards show your brand mark.',
  },
  "meta.charset": {
    title: "Declare charset",
    how: 'Add `<meta charset="utf-8">` as the first child of <head> so non-ASCII content is parsed reliably.',
  },

  // --- Schema breadth ---
  "schema.article": {
    title: "Add Article / BlogPosting JSON-LD",
    how: "On every blog/article page, include Article JSON-LD with headline, author, datePublished, dateModified. AI engines weight these heavily for freshness and authority.",
  },
  "schema.breadcrumb": {
    title: "Add BreadcrumbList JSON-LD",
    how: "Helps AI engines understand site hierarchy and improves citation context.",
  },
  "schema.local_business": {
    title: "Add LocalBusiness JSON-LD (if you have a physical location)",
    how: "Include address, geo, openingHours, telephone. Required for AI engines to surface you in 'near me' queries.",
  },
  "schema.person": {
    title: "Add Person JSON-LD for authors / founders",
    how: "Mark up bylines and founder bios with Person schema — name, jobTitle, sameAs (their profiles). Strengthens E-E-A-T.",
  },
  "schema.howto": {
    title: "Add HowTo JSON-LD for step-by-step content",
    how: "For any 'how to' page, wrap the steps in HowTo JSON-LD. AI step-by-step answers cite these heavily.",
  },
  "schema.video": {
    title: "Add VideoObject JSON-LD",
    how: "For embedded videos, include VideoObject with thumbnailUrl, uploadDate, duration. AI engines cite these in multimedia answers.",
  },

  // --- Content quality ---
  "content.heading_order": {
    title: "Fix heading-level skips",
    how: "Don't jump from h2 to h4. AI outline parsers expect monotonic nesting — keep heading depth contiguous.",
  },
  "content.snippet_blocks": {
    title: "Add lists or comparison tables",
    how: "Answer engines lift bulleted lists, numbered steps, and tables verbatim. Add at least 2 snippet-ready blocks to the homepage.",
  },
  "content.qa_headings": {
    title: "Phrase a heading as a user question",
    how: "Use headings like 'How does pricing work?' or 'Who is this for?' — they map directly to conversational AI queries.",
  },
  "content.date_signal": {
    title: "Publish a date signal",
    how: 'Add `<time datetime="2026-05-17">` or `<meta property="article:published_time">`. AI ranking heavily weights freshness.',
  },
  "content.author": {
    title: "Declare an author byline",
    how: 'Add `<meta name="author" content="Name">` or a visible byline with `rel="author"`. Combine with Person JSON-LD for E-E-A-T.',
  },
  "content.text_ratio": {
    title: "Raise your text-to-HTML ratio",
    how: "Strip unused inline scripts/styles and move large bundles to external files. AI crawlers struggle when most of the response is markup.",
  },

  // --- Images ---
  "images.format": {
    title: "Use modern image formats",
    how: "Serve WebP or AVIF for hero/above-the-fold images. Keep legacy PNG/JPG only as <picture> fallbacks.",
  },
  "images.lazy_loading": {
    title: "Lazy-load below-the-fold images",
    how: 'Add `loading="lazy"` on `<img>` tags that aren\'t in the initial viewport. Reduces first-paint payload.',
  },
  "images.dimensions": {
    title: "Set width/height on images",
    how: "Explicit dimensions prevent Cumulative Layout Shift and help AI extractors reserve space correctly.",
  },
  "images.srcset": {
    title: "Use srcset/sizes for responsive images",
    how: "Serve appropriately-sized images per viewport — saves bytes on mobile crawls.",
  },

  // --- Links ---
  "links.nofollow_ratio": {
    title: "Review nofollow usage on outbound links",
    how: "Nearly-all-nofollow can read as a link-spam pattern. Use nofollow only for paid/UGC links per Google's guidance.",
  },
  "links.broken_sample": {
    title: "Fix broken homepage links",
    how: "We HEAD-probed the first 20 unique homepage links and found 4xx/5xx responses. Repair or remove them — broken links erode crawler trust.",
  },

  // --- Performance ---
  "perf.page_size": {
    title: "Reduce page size",
    how: "AI crawlers commonly truncate over ~1.5 MB. Strip unused JS, defer below-the-fold images, and gzip/brotli all responses.",
  },
  "perf.resource_count": {
    title: "Reduce resource count",
    how: "Bundle scripts/styles, sprite or inline-SVG your icons, and use system fonts where possible.",
  },
  "perf.render_blocking": {
    title: "Eliminate render-blocking head scripts",
    how: 'Add `defer` or `async` to any `<script src="…">` in `<head>`, or move it to the end of `<body>`.',
  },
  "perf.inline_bulk": {
    title: "Externalize large inline JS/CSS",
    how: "Inline blobs aren't cacheable. Move >50 KB inline payloads to versioned external files.",
  },
  "perf.response_time": {
    title: "Reduce response time",
    how: "Push static HTML to a CDN edge cache. If you must server-render per-request, profile DB/template work and add `Cache-Control: s-maxage=…`.",
  },
  "perf.caching": {
    title: "Set a Cache-Control header",
    how: "Add `Cache-Control: public, max-age=300, s-maxage=3600` (or similar) so CDNs and AI crawlers can revalidate cheaply.",
  },

  // --- Security ---
  "security.https": {
    title: "Serve the site over HTTPS",
    how: "Provision a certificate (Let's Encrypt, Caddy, or your platform's automatic cert) and redirect http→https at the edge.",
  },
  "security.mixed_content": {
    title: "Fix mixed content",
    how: "An https page loading http assets is downgraded by browsers and AI crawlers. Update asset URLs or use protocol-relative paths.",
  },
  "security.hsts": {
    title: "Enable HSTS",
    how: "Add `Strict-Transport-Security: max-age=31536000; includeSubDomains` once you're confident every subdomain is https-ready.",
  },
  "security.csp": {
    title: "Define a Content-Security-Policy",
    how: "Start with `Content-Security-Policy-Report-Only` to learn safe sources, then enforce. Cuts XSS blast radius.",
  },
  "security.xfo": {
    title: "Add X-Frame-Options",
    how: "`X-Frame-Options: SAMEORIGIN` (or CSP `frame-ancestors`) blocks clickjacking via iframe embeds.",
  },
  "security.xcto": {
    title: "Add X-Content-Type-Options",
    how: "`X-Content-Type-Options: nosniff` prevents browsers from MIME-sniffing responses.",
  },
  "security.referrer": {
    title: "Set a Referrer-Policy",
    how: "`Referrer-Policy: strict-origin-when-cross-origin` is a safe default.",
  },
  "security.permissions": {
    title: "Set a Permissions-Policy",
    how: "Restrict browser features you don't use, e.g. `Permissions-Policy: camera=(), microphone=(), geolocation=()`.",
  },

  // --- GEO (Generative Engine Optimization) ---
  "geo.llms_txt": {
    title: "Create or enrich /llms.txt",
    how:
      "Follow the llmstxt.org spec:\n\n" +
      "```\n" +
      "# Your Brand\n\n" +
      "> One-line description of your site.\n\n" +
      "## Docs\n\n" +
      "- [Getting Started](https://yoursite.com/docs/start): How to get up and running.\n" +
      "- [API Reference](https://yoursite.com/docs/api): Full API details.\n\n" +
      "## About\n\n" +
      "- [About us](https://yoursite.com/about): Mission and team.\n" +
      "```\n\n" +
      "Include at least 2 section headings, 3+ linked resources, and a brief description per link. " +
      "A rich llms.txt dramatically increases how often generative AI systems cite your content.",
  },
  "geo.llms_full_txt": {
    title: "Generate /llms-full.txt for RAG pipelines",
    how:
      "llms-full.txt is a concatenation of the full markdown text of every resource listed in llms.txt. " +
      "Generate it statically at build time and serve it from your root:\n\n" +
      "```\n" +
      "# Your Brand — Full Content\n\n" +
      "## Getting Started\n" +
      "<full markdown content of /docs/start>\n\n" +
      "## API Reference\n" +
      "<full markdown content of /docs/api>\n" +
      "```\n\n" +
      "Large-context models can ingest your entire knowledge base in a single request, " +
      "dramatically improving recall and citation accuracy.",
  },
  "geo.knowledge_graph": {
    title: "Add sameAs knowledge graph links to Organization schema",
    how:
      "Extend your Organization JSON-LD to include `sameAs` pointing to authoritative directories:\n\n" +
      "```json\n" +
      "{\n" +
      '  "@context": "https://schema.org",\n' +
      '  "@type": "Organization",\n' +
      '  "name": "Your Brand",\n' +
      '  "url": "https://yoursite.com",\n' +
      '  "sameAs": [\n' +
      '    "https://en.wikipedia.org/wiki/Your_Brand",\n' +
      '    "https://www.wikidata.org/wiki/Q12345678",\n' +
      '    "https://www.linkedin.com/company/your-brand",\n' +
      '    "https://www.crunchbase.com/organization/your-brand"\n' +
      "  ]\n" +
      "}\n" +
      "```\n\n" +
      "These links anchor your brand as a known entity in AI knowledge graphs, " +
      "making it far more likely that generative models cite you by name rather than paraphrase.",
  },
  "geo.agent_integration": {
    title: "Add an AI agent integration file",
    how:
      "At minimum, add a skill.md at /skill.md so Claude and similar agents can discover your API:\n\n" +
      "```markdown\n" +
      "# Your Brand Skill\n\n" +
      "API endpoint: https://yoursite.com/api\n" +
      "Auth: Bearer token\n\n" +
      "## Tools\n\n" +
      "- search: Search the knowledge base\n" +
      "- get_article: Retrieve a full article by ID\n" +
      "```\n\n" +
      "Also consider /.well-known/ai-plugin.json (ChatGPT plugin discovery) and " +
      "/.well-known/agent-card.json (Google A2A protocol) for broader agent compatibility.",
  },
  "geo.brand_entity": {
    title: "Declare your brand name in Organization JSON-LD",
    how:
      'Add `"name": "Your Brand"` to your Organization or SoftwareApplication schema block. ' +
      "AI systems match structured-data names against training data to resolve your brand " +
      "as a distinct entity. Without it, mentions of your brand may not be attributed to you.",
  },
  "geo.citation_signals": {
    title: "Add outbound links to authoritative sources",
    how:
      "Link to Wikipedia, .gov or .edu resources, peer-reviewed studies, or major news outlets " +
      "when making factual claims. Generative AI systems treat pages that cite authoritative sources " +
      "as more trustworthy, which raises citation likelihood.\n\n" +
      "Examples: statistics from Statista or Census.gov, definitions from Wikipedia, " +
      "research from nature.com or pubmed.ncbi.nlm.nih.gov.",
  },
};

// Add an aibot.* template for every blocked AI bot.
function aibotRec(check_key: string): { title: string; how: string } {
  const bot = check_key.split(".")[1];
  return {
    title: `Allow ${bot} in robots.txt`,
    how: `Add an explicit\n  User-agent: ${bot}\n  Allow: /\nblock so this AI crawler can read your site.`,
  };
}

export type Recommendation = {
  check_key: string;
  section: string;
  priority: 1 | 2 | 3 | 4 | 5;
  title: string;
  how: string;
};

export function deriveRecommendations(findings: Finding[]): Recommendation[] {
  const recs: Recommendation[] = [];
  for (const f of findings) {
    if (f.status !== "fail" && f.status !== "warn") continue;
    const tmpl = RECS[f.check_key] ?? (f.check_key.startsWith("aibot.") ? aibotRec(f.check_key) : null);
    if (!tmpl) continue;
    recs.push({
      check_key: f.check_key,
      section: f.section,
      priority: f.priority,
      title: tmpl.title,
      how: tmpl.how,
    });
  }
  // Sort by priority (1 first), then section.
  recs.sort((a, b) => a.priority - b.priority || a.section.localeCompare(b.section));
  return recs;
}
