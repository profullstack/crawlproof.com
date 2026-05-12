# CrawlProof

> See your site the way AI crawlers do.

CrawlProof runs an AEO audit on any URL and produces a structured report of what LLM crawlers and answer engines can actually find — content, schema, robots rules, AI-bot access, positioning clarity, and recommended fixes.

## Stack

- **Next.js 16** (App Router, React Server Components, Server Actions)
- **Tailwind v4** for styling
- **Supabase** (Postgres + Auth + Storage)
- **Stripe** (subscriptions)
- **Resend** (transactional email)
- **Playwright** (rendered-vs-static check + PDF export) — runs in an external worker
- Worker on **Fly.io** / Railway; Next.js on **Vercel**

## Repo layout

```
app/                Next.js routes (marketing + app + auth + api + cron)
components/         React components (server + client)
lib/
  audit/            Audit engine: fetch, render, checks, scoring, recs
  supabase/         server / client / service-role helpers
  email.ts          Resend wrapper
  rateLimit.ts      Anonymous + tier limits
  stripe.ts         Stripe client
  shareToken.ts     URL-safe token generator
  env.ts            Typed env access
supabase/migrations Postgres schema, RLS, cron
worker/             External Playwright worker (Docker, Fly.io)
```

## Local setup

1. **Install deps**:
   ```bash
   npm install
   cd worker && npm install && cd ..
   npx playwright install chromium
   ```

2. **Provision Supabase** (cloud or local CLI):
   ```bash
   supabase db push   # applies supabase/migrations/*
   ```
   Then run once on the database:
   ```sql
   alter database postgres set app.site_url = 'http://localhost:3000';
   alter database postgres set app.cron_secret = 'YOUR_CRON_SECRET';
   ```

3. **Create `.env.local`** from `.env.example` and fill in:
   - `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
   - `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRO_PRICE_ID`
   - `RESEND_API_KEY` (optional — emails are skipped if unset)
   - `WORKER_URL`, `WORKER_SHARED_SECRET`
   - `CRON_SECRET`

4. **Run dev**:
   ```bash
   # Terminal 1 — Next.js
   npm run dev

   # Terminal 2 — worker
   npm run worker
   ```

## Deploy

### Next.js → Vercel
Set every env var above in the Vercel project. The bundled `vercel.json` registers an hourly cron at `/api/cron/scheduled-audits` which Vercel signs with `Authorization: Bearer $CRON_SECRET`.

### Worker → Fly.io
The worker needs Playwright, so it cannot run on Vercel. From `worker/`:
```bash
fly launch --copy-config --no-deploy
fly secrets set \
  NEXT_PUBLIC_SUPABASE_URL=... \
  SUPABASE_SERVICE_ROLE_KEY=... \
  NEXT_PUBLIC_SITE_URL=https://crawlproof.com \
  WORKER_SHARED_SECRET=... \
  RESEND_API_KEY=... RESEND_FROM=...
fly deploy
```
Set `WORKER_URL` in Vercel to the Fly app URL (e.g. `https://crawlproof-worker.fly.dev`).

### Stripe webhook
Point a webhook at `https://crawlproof.com/api/stripe/webhook` for the events:
- `checkout.session.completed`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`

## Self-audit goal

CrawlProof itself ships:
- `robots.txt` with explicit Allow for GPTBot/ClaudeBot/PerplexityBot/etc (`app/robots.ts`)
- `sitemap.xml` (`app/sitemap.ts`)
- `llms.txt` (`app/llms.txt/route.ts`)
- `skill.md` (`app/skill.md/route.ts`)
- `/.well-known/ai-plugin.json` (`app/.well-known/ai-plugin.json/route.ts`)
- JSON-LD: Organization, SoftwareApplication, FAQPage, BlogPosting, BreadcrumbList

Running CrawlProof on `https://crawlproof.com` should score 100/100.

## What the audit checks

Every audit produces the canonical 10 sections from `lib/audit/prompt.ts`:

1. **Crawl Summary** — pages fetched, status codes, byte size, fetch time
2. **Data Found** — Pricing, customer logos, recent launches, new hires, blog activity, headline copy, positioning, team, product/service descriptions, case studies, social proof, contact paths
3. **Homepage Audit** — H1, title, meta, canonical, OG, JS-rendered ratio, alt-text coverage
4. **Schema / Structured Data Audit** — JSON-LD presence + validity, Organization, WebSite, Product/SoftwareApplication, FAQPage
5. **robots.txt and sitemap.xml Audit** — exists, references sitemap, sitemap URL count
6. **LLM / AI Crawler Accessibility** — GPTBot, ClaudeBot, PerplexityBot, Google-Extended, OAI-SearchBot, Applebot-Extended, CCBot + llms.txt + skill.md + ai-plugin.json
7. **Positioning Clarity** — H1 quality, value prop, audience, pricing path, CTA discoverability
8. **Missing or Hard-to-Find Information** — roll-up of unfound data points
9. **Recommended Fixes** — actionable, templated, prioritized
10. **Priority To-Do Checklist** — copy-paste-able checklist

## License

Proprietary. © CrawlProof.
