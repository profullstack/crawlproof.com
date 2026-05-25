# CrawlProof

> See your site the way AI crawlers do.

CrawlProof runs an AEO audit on any URL and produces a structured report of what LLM crawlers and answer engines can actually find — content, schema, robots rules, AI-bot access, positioning clarity, and recommended fixes.

## Stack

- **Next.js 16** (App Router, React Server Components, Server Actions)
- **Tailwind v4** for styling
- **Supabase** (Postgres + Auth + Storage)
- **CoinPay** (crypto credit purchases)
- **Resend** (transactional email)
- **Playwright** (rendered-vs-static check + PDF export) - runs in an external worker
- **LLM providers** for paid scans: Anthropic, OpenAI, Gemini, Qwen, Kimi, DeepSeek, Perplexity
- Both services deploy to **Railway** (Next.js app + worker, two services in the same project)

## Repo layout

```
app/                Next.js routes (marketing + app + auth + api + cron)
components/         React components (server + client)
lib/
  audit/            Audit engine: fetch, render, checks, scoring, recs
  lx/               Autoblog / link-exchange / keyword research flows
  sp/               Social posting accounts, OAuth, API tokens, publishing
  github/           GitHub App install, repo binding, automated fix PRs
  supabase/         server / client / service-role helpers
  coinpay.ts        CoinPay invoice + webhook helpers
  email.ts          Resend wrapper
  rateLimit.ts      Anonymous limits, URL safety, credit helpers
  shareToken.ts     URL-safe token generator
  env.ts            Typed env access
supabase/migrations Postgres schema, RLS, cron
worker/             Audit, PDF, keyword, article, and delivery worker (Docker)
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
   - `COINPAY_MERCHANT_ID`, `COINPAY_API_KEY`, `COINPAY_WEBHOOK_SECRET`
   - `RESEND_API_KEY` (optional — emails are skipped if unset)
   - `WORKER_URL`, `WORKER_SHARED_SECRET`
   - `CRON_SECRET`
   - `BACKEND_AI_PROVIDER` (`openai` by default, or `auto` / `anthropic`) for Autoblog text generation
   - Provider keys for enabled paid engines: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `DASHSCOPE_API_KEY`, `MOONSHOT_API_KEY`, `DEEPSEEK_API_KEY`, `PERPLEXITY_API_KEY`

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
  - `COINPAY_MERCHANT_ID`, `COINPAY_API_KEY`, `COINPAY_WEBHOOK_SECRET`
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
  - `BACKEND_AI_PROVIDER` plus LLM / data provider keys used by worker jobs: Anthropic, OpenAI, DataForSEO, etc.

In the app service, set `WORKER_URL` to the worker's Railway private URL — Railway provides `http://${{crawlproof-worker.RAILWAY_PRIVATE_DOMAIN}}:${{crawlproof-worker.PORT}}` via variable references.

### Cron — handled by Supabase pg_cron

`supabase/migrations/0003_cron.sql` already schedules an hourly call to `/api/cron/scheduled-audits` via `pg_cron` + `pg_net`. Run once on the Supabase database:

```sql
alter database postgres set app.site_url = 'https://crawlproof.com';
alter database postgres set app.cron_secret = '<your CRON_SECRET>';
```

This is host-agnostic and replaces Vercel cron entirely.

### CoinPay webhook

Point CoinPay webhook delivery at:

```text
https://<your-domain>/api/coinpay/webhook
```

Credit purchases are created through `/api/credits/create-invoice`; successful webhook delivery finalizes the purchase and increments `profiles.credits_balance`.

## Product flows

### Free audit

The homepage form queues a free rule-based audit. Email is optional: users get the on-page report immediately via `/r/<share_token>`, and receive a PDF only when they provide an email. Anonymous free scans are unlisted by default; `/recent` and sitemap deep links include only scans where the submitter explicitly opted into public listing. Common tracking parameters such as `utm_*`, `fbclid`, and `gclid` are stripped before new URLs are saved.

### Project scan

Signed-in users can save sites as projects, choose one or more engines, and run scans from the project page. A multi-engine scan creates one `audits` row per engine and ties them together with `scan_run_id` for side-by-side reports, consolidated Markdown/PDF, and project score history.

### Credits and engines

Rule-based scans cost 0 credits. Paid AI-model scans cost 1 credit per engine. Credit packs are defined in `lib/credits.ts`; failures and user-aborted paid scans refund credits.

### Autoblog / link exchange

The `lx_*` tables and `lib/lx/*` modules power site setup, sitemap crawling, keyword research through DataForSEO, article generation, guest posts, backlinks, and webhook delivery. Worker endpoints under `/lx/*` process the long-running pieces.

### Social posting

The `sp_*` tables and `lib/sp/*` modules support connected social accounts, encrypted tokens, project-level account bindings, API tokens, and post publishing.

### GitHub integration

The GitHub App flow stores installations and project repo bindings. Reports can offer "apply fix" actions that open PRs against connected repos.

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
