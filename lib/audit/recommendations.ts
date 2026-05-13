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
