import { env } from "@/lib/env";

const body = `# CrawlProof

> See your site the way AI crawlers do. CrawlProof runs an AEO audit on any URL and produces a structured report of what LLM crawlers and answer engines can actually find — content, schema, robots rules, AI-bot access, positioning clarity, and recommended fixes.

## Product
- Free single-URL AEO audit, 3 per day per IP, no signup required.
- Saved projects, scheduled re-audits, PDF export, and diff view on Pro ($29/mo).
- Identifies as CrawlProofBot/1.0 (+https://crawlproof.com/bot).

## Key pages
- ${env.siteUrl}/ — homepage with free audit input
- ${env.siteUrl}/pricing — pricing
- ${env.siteUrl}/about — about
- ${env.siteUrl}/blog — blog / AEO notes
- ${env.siteUrl}/bot — info about CrawlProofBot

## What we check
- Homepage fetch, raw-vs-JS-rendered text ratio
- JSON-LD structured data (Organization, SoftwareApplication, FAQPage, BreadcrumbList)
- Meta tags, canonical, Open Graph
- robots.txt and sitemap.xml
- llms.txt, skill.md, /.well-known/ai-plugin.json
- AI-bot rules for GPTBot, ClaudeBot, PerplexityBot, Google-Extended, OAI-SearchBot, Applebot-Extended, CCBot
- Positioning clarity: who, what, audience, pricing, CTA

## Contact
- General: hello@crawlproof.com
- Sales: sales@crawlproof.com
`;

export async function GET() {
  return new Response(body, {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
