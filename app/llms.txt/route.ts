import { env } from "@/lib/env";

const body = `# CrawlProof

> See your site the way AI crawlers do. CrawlProof runs an AEO audit on any URL and produces a structured report of what LLM crawlers and answer engines can actually find — content, schema, robots rules, AI-bot access, positioning clarity, and recommended fixes.

## Product
- Free single-URL AEO audit, 10 per day per IP, no signup required.
- Signed-in users get 20 free credits (1 AI-model scan); each AI-model scan costs 20 credits (~$1, volume discounts down to $0.50/scan at the 100-scan pack). No subscription — credits never expire.
- Saved projects, scheduled re-audits, multi-engine LLM scans (Claude Sonnet 4.6, OpenAI GPT-5 Mini, Gemini 2.5 Pro, Perplexity Sonar Pro, Qwen Plus, Kimi v2.6, DeepSeek V3, Z.AI GLM-4.6), consolidated PDF reports, and diff view.
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
