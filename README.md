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
- Both services deploy to **Railway** (Next.js app + worker, two services in the same project)

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
worker/             External Playwright + pandoc worker (Docker)
Dockerfile          Next.js production image (Railway)
railway.json        Railway service config — Next.js app
railway.worker.json Railway service config — worker (set as "Config File Path")
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

## Deploy (Railway)

Both services live in a single Railway project. Connect this repo to Railway, then create two services from the same repo:

### Service 1: `crawlproof-app` (Next.js)

- **Root Directory:** `/` (repo root)
- **Config File Path:** `railway.json` (default; uses the root `Dockerfile`)
- **Env vars** (everything from `.env.example`):
  - `NEXT_PUBLIC_SITE_URL` — your Railway domain or custom domain
  - `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
  - `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRO_PRICE_ID`
  - `RESEND_API_KEY`, `RESEND_FROM`
  - `WORKER_URL` — the worker service's internal URL (see below)
  - `WORKER_SHARED_SECRET`, `CRON_SECRET`

Railway sets `PORT` automatically; the Dockerfile listens on it.

### Service 2: `crawlproof-worker` (Playwright + pandoc)

- **Root Directory:** `/` (repo root — required so the Dockerfile can `COPY lib/`)
- **Config File Path:** `railway.worker.json` (uses `worker/Dockerfile`)
- **Env vars:**
  - `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
  - `NEXT_PUBLIC_SITE_URL` — same as app, used for share-link emails
  - `WORKER_SHARED_SECRET` — must match the app's value
  - `RESEND_API_KEY`, `RESEND_FROM` (optional)

In the app service, set `WORKER_URL` to the worker's Railway private URL — Railway provides `http://${{crawlproof-worker.RAILWAY_PRIVATE_DOMAIN}}:${{crawlproof-worker.PORT}}` via variable references.

### Cron — handled by Supabase pg_cron

`supabase/migrations/0003_cron.sql` already schedules an hourly call to `/api/cron/scheduled-audits` via `pg_cron` + `pg_net`. Run once on the Supabase database:

```sql
alter database postgres set app.site_url = 'https://crawlproof.com';
alter database postgres set app.cron_secret = '<your CRON_SECRET>';
```

This is host-agnostic and replaces Vercel cron entirely.

### Stripe webhook

Point a Stripe webhook at `https://<your-railway-domain>/api/stripe/webhook` for:
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
