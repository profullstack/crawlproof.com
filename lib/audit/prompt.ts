// The canonical specification for what an AEO audit must produce.
// This is the prompt that defines our deliverable — every check, every
// section, every output piece below is implemented by the engine in
// lib/audit/engine.ts. Keep this in sync with engine output.

export const AUDIT_PROMPT_TEMPLATE = (target: string) => `Pretend you've never heard of my company: ${target}

Only use what you can find on the public web. Act like an LLM crawler discovering the site for the first time.

Research and extract anything you can find about the company, including:

- Pricing
- Customer logos
- Recent launches
- New hires
- Blog post activity
- Headline copy
- Positioning
- Executive team
- Product/service descriptions
- Case studies or testimonials
- Social proof
- Contact/demo/signup paths

For each data point, tell me exactly how you found it:
- Homepage
- Navigation links
- Footer links
- Blog
- Pricing page
- About/team page
- Schema/structured data
- robots.txt
- sitemap.xml
- Search results
- Social profiles
- Press/news pages
- Other public sources

If you cannot find something easily, stop and explain what the challenge is.

Also audit the AEO basics:

1. Fetch the homepage.
2. Flag whether important content appears to be JavaScript-rendered.
3. Check for schema/structured data.
4. Read robots.txt.
5. Check sitemap.xml.
6. Look for LLM crawler rules or AI bot access rules.
7. Identify whether the site clearly explains:
   - Who the company is
   - What it does
   - Who it serves
   - Why it is different
   - How to buy, sign up, or contact sales

Summarize:

- What was easy to find
- What was hard to find
- What was impossible to find
- What methods you used
- What the company should fix
- What pages or metadata should be added
- What would improve discoverability for AI search, LLM crawlers, and answer engines

Output format:

# AEO Audit for {{COMPANY}}

## 1. Crawl Summary

## 2. Data Found

| Data Point | Found? | Source | Notes |
|---|---:|---|---|

## 3. Homepage Audit

## 4. Schema / Structured Data Audit

## 5. robots.txt and sitemap.xml Audit

## 6. LLM / AI Crawler Accessibility

## 7. Positioning Clarity

## 8. Missing or Hard-to-Find Information

## 9. Recommended Fixes

## 10. Priority To-Do List

Create the to-do list as actionable checklist items I can reuse after every major website change.`;

// Canonical list of data points we extract.
export const DATA_POINTS = [
  "Pricing",
  "Customer logos",
  "Recent launches",
  "New hires",
  "Blog post activity",
  "Headline copy",
  "Positioning",
  "Executive team",
  "Product/service descriptions",
  "Case studies or testimonials",
  "Social proof",
  "Contact/demo/signup paths",
] as const;

export type DataPoint = (typeof DATA_POINTS)[number];

// Canonical list of source labels.
export const SOURCES = [
  "Homepage",
  "Navigation links",
  "Footer links",
  "Blog",
  "Pricing page",
  "About/team page",
  "Schema/structured data",
  "robots.txt",
  "sitemap.xml",
  "Search results",
  "Social profiles",
  "Press/news pages",
  "Other public sources",
] as const;

export type SourceLabel = (typeof SOURCES)[number];

export const SECTIONS = [
  "Crawl Summary",
  "Data Found",
  "Homepage Audit",
  "Content Quality",
  "Schema / Structured Data Audit",
  "Links & Images",
  "Performance",
  "Security",
  "robots.txt and sitemap.xml Audit",
  "LLM / AI Crawler Accessibility",
  "Generative Engine Optimization (GEO)",
  "Positioning Clarity",
  "Foundations",
  "Accessibility",
  "Well-Known URIs",
  "Privacy",
  "Resilience",
  "Website Specification",
  "Missing or Hard-to-Find Information",
  "Recommended Fixes",
  "Priority To-Do List",
] as const;

export type SectionName = (typeof SECTIONS)[number];

// The single source of truth for the AEO audit task. Every LLM engine
// renders this exact prompt as its USER turn; engine-specific guidance
// (tool hints, JSON output schema) stays in each engine's SYSTEM prompt.
// Keep this in sync with the spec the user posted in 2026-05-13.
export function buildAEOUserPrompt(input: {
  targetUrl: string;
  companyName?: string;
}): string {
  const name = input.companyName ?? input.targetUrl;
  return `Pretend you've never heard of my company: ${input.targetUrl}

Only use what you can find on the public web. Act like an LLM crawler discovering the site for the first time.

Research and extract anything you can find about the company, including:

${DATA_POINTS.map((d) => `- ${d}`).join("\n")}

For each data point, tell me exactly how you found it:

${SOURCES.map((s) => `- ${s}`).join("\n")}

If you cannot find something easily, stop and explain what the challenge is.

Also audit the AEO basics:

1. Fetch the homepage.
2. Flag whether important content appears to be JavaScript-rendered.
3. Check for schema/structured data.
4. Read robots.txt.
5. Check sitemap.xml.
6. Look for LLM crawler rules or AI bot access rules.
7. Identify whether the site clearly explains:
   - Who the company is
   - What it does
   - Who it serves
   - Why it is different
   - How to buy, sign up, or contact sales

Summarize:

- What was easy to find
- What was hard to find
- What was impossible to find
- What methods you used
- What the company should fix
- What pages or metadata should be added
- What would improve discoverability for AI search, LLM crawlers, and answer engines

Output format:

# AEO Audit for ${name}

${SECTIONS.map((s, i) => `## ${i + 1}. ${s}`).join("\n\n")}

(For section 2, render a Markdown table: | Data Point | Found? | Source | Notes |)

Create the section ${SECTIONS.length} to-do list as actionable checklist items I can reuse after every major website change.`;
}
