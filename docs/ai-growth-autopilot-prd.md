# CrawlProof AI Growth Autopilot — PRD

> Goal: close the missing product gaps against BabyLoveGrowth.ai by turning CrawlProof from an audit-first tool with adjacent modules into a packaged AI organic-growth platform: content plan, publishing, verified backlink exchange, LLM prompt visibility, technical fixes, and proof-oriented reporting in one workflow.
>
> Competitive basis: public BabyLoveGrowth.ai review performed 2026-06-06. Their public offer emphasizes 30 SEO/LLM articles per month, automated publishing, backlinks through a large partner network, technical GEO audits, Reddit visibility, analytics, prompt visibility, many CMS integrations, and a simple all-in-one subscription.

---

## Status as of 2026-06-06

**Phase 0 — PRD: this document.**

**Already in CrawlProof:**
- Deep SEO/AEO/GEO audits across rule/spec/LLM engines.
- Project score history, scan runs, Markdown/PDF/shareable reports.
- Autoblog setup, sitemap discovery, editorial enrichment, DataForSEO keyword expansion, scheduled article generation, image generation, preview/publish workflow, and webhook delivery.
- Link-exchange matcher and `lx_backlink` ledger/display.
- Guest-post opportunity and generation flows.
- Drop-in stats tracker for AI referrals, AI/bot crawls, human traffic, pages, referrers, events, and geo.
- Social posting and feed autopost infrastructure.
- GitHub repo binding, stats install PRs, and audit-finding "apply fix" PRs.

**Missing or underbuilt versus BLG:**
- One packaged subscription offer that says what the customer gets every month.
- 30-day content calendar UI with topic replacement, article type, KD/search volume, instructions, and edit/approve/publish controls.
- Prompt-level LLM visibility tracking: monitored prompts, model answers, brand mentions, competitors, sources, visibility score.
- Backlink verification, removal rechecks, fair-share/credit accounting, and quality thresholds.
- Native CMS connectors beyond webhook/API-style delivery.
- Google Search Console import for clicks, impressions, queries, pages, and rank movement.
- Reddit opportunity discovery tied to monitored keywords and generated response drafts.
- Public proof surface: case studies, sample dashboards, metric snapshots, and outcome reporting.

---

## 1. Product Positioning

### Current positioning problem

The public site leads with "See your site the way AI crawlers do." That is accurate, but it makes CrawlProof sound like a diagnostic utility. BLG sells the buyer outcome: traffic growth on autopilot from Google and AI search.

### New package

**CrawlProof Autopilot**

One monthly workflow:
1. Audit the site for search and AI discoverability.
2. Build a 30-day content plan from the site, competitors, sitemap, and monitored prompts.
3. Generate and publish SEO/LLM-optimized articles.
4. Insert internal links and verified partner backlinks.
5. Track Google Search Console, AI referrals, AI crawls, and prompt visibility.
6. Open GitHub PRs for technical fixes when possible.

### Offer copy

> CrawlProof Autopilot publishes search-ready articles, verifies AI and crawler access, tracks where AI engines mention you, and builds transparent partner backlinks without hiding the work.

### Initial SKU

`Autopilot`
- 30 generated articles/month.
- 1 connected project/site.
- Scheduled technical audits.
- Stats tracker and AI referral/bot analytics.
- Prompt visibility tracking for 25 prompts.
- Verified backlink exchange participation.
- Webhook/API publishing.
- GitHub fix PRs billed by credits or included up to a monthly cap.

Keep existing credits for overages and usage-based scans. Add subscription entitlements rather than replacing credits.

---

## 2. Principles

1. **Transparent exchange, not hidden PBN.** Every exchange link is visible to both parties, verified, and removable from the network if quality rules fail.
2. **Audit before automation.** The product should identify crawl/AI-readability blockers before asking users to pay for more content.
3. **Prompt visibility is evidence.** We need actual model responses, cited sources, and competitor mentions, not just traffic counters.
4. **Human review remains available.** Autopublish can exist, but article preview/edit/approve must remain a first-class mode.
5. **Use existing project boundaries.** Build on `projects`, `lx_site`, `lx_keyword`, `lx_article`, `lx_backlink`, tracker tables, and `project_repos`.

---

## 3. Phase 1 — Packaging And Entitlements

### Goal

Create a product package that competes with BLG's all-in-one monthly plan without disrupting the current credit model.

### User stories

- As a founder, I can buy "Autopilot" and know I get 30 articles/month plus audits, tracking, and backlinks.
- As an existing credit customer, I can keep buying credits for extra scans/articles.
- As an operator, I can see monthly entitlement usage per project.

### Scope

Schema:

```sql
create table public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  plan text not null check (plan in ('autopilot', 'agency')),
  status text not null check (status in ('active', 'past_due', 'cancelled')),
  current_period_start timestamptz not null,
  current_period_end timestamptz not null,
  provider text not null default 'manual',
  provider_subscription_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.project_entitlements (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  subscription_id uuid references public.subscriptions(id) on delete set null,
  period_start timestamptz not null,
  period_end timestamptz not null,
  articles_included integer not null default 30,
  articles_used integer not null default 0,
  prompts_included integer not null default 25,
  prompts_used integer not null default 0,
  fix_prs_included integer not null default 5,
  fix_prs_used integer not null default 0,
  unique(project_id, period_start)
);
```

UI:
- Add `/pricing` or expand homepage pricing with `Autopilot`.
- Add project usage cards: articles used, prompts tracked, fix PRs used.
- Update buy-credits modal to explain overages.

Acceptance criteria:
- Article generation consumes included monthly article quota before credits.
- Paid scans keep using credits unless explicitly included later.
- Failed article generations do not consume quota.
- Usage resets on the subscription period boundary.

---

## 4. Phase 2 — 30-Day Content Plan

### Goal

Turn the existing `lx_keyword` queue into a calendar/planner comparable to BLG's Content Plan.

### User stories

- As a user, I can see the next 30 days of planned topics.
- I can drag/reschedule or change a topic.
- I can see search volume and keyword difficulty where available.
- I can add custom instructions and product images per planned article.
- I can edit title, slug, meta description, and content before publishing.

### Scope

Schema changes:

```sql
alter table public.lx_keyword
  add column if not exists keyword_difficulty integer,
  add column if not exists article_type text,
  add column if not exists article_subtype text,
  add column if not exists custom_instructions text,
  add column if not exists status_reason text,
  add column if not exists source text,
  add column if not exists source_context jsonb not null default '{}'::jsonb;

create table public.lx_keyword_asset (
  id uuid primary key default gen_random_uuid(),
  keyword_id uuid not null references public.lx_keyword(id) on delete cascade,
  storage_path text not null,
  alt_text text,
  created_at timestamptz not null default now()
);
```

Routes:
- `/projects/[id]/autoblog/plan`
- `/api/lx/keywords/[id]/reschedule`
- `/api/lx/keywords/[id]/replace`
- `/api/lx/keywords/[id]/instructions`

UI:
- Month calendar plus compact list view.
- Topic detail drawer.
- Replace topic flow using DataForSEO suggestions and competitor/site profile.
- Article status: planned, generating, ready, published, failed.
- Search volume/KD chips.

Data:
- Extend `lib/lx/dataforseo.ts` to store KD where provider response supports it.
- Infer `article_type` from buyer journey and SERP intent:
  - guide
  - comparison
  - listicle
  - alternative
  - FAQ
  - tutorial
  - case-study
  - glossary

Acceptance criteria:
- A new Autopilot project gets a 30-day plan during setup.
- Calendar operations update `lx_keyword.scheduled_for` without corrupting generation order.
- Per-topic instructions are passed into `lib/lx/articleGen.ts`.
- Existing Autoblog dashboard links to Plan as the primary workflow.

---

## 5. Phase 3 — LLM Prompt Visibility

### Goal

Add BLG-style prompt monitoring: track whether ChatGPT/OpenAI, Claude, Gemini, Perplexity, and other engines mention the user's brand, competitors, and sources for monitored prompts.

### User stories

- As a user, I can define prompts my buyer might ask.
- CrawlProof runs those prompts on a schedule.
- I can see whether my brand is mentioned, which competitors appear, and which sources are cited.
- I can inspect actual responses.
- I can connect poor prompt performance to recommended content, backlinks, or technical fixes.

### Scope

Schema:

```sql
create table public.prompt_monitor (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  prompt text not null,
  target_brand text not null,
  competitors text[] not null default '{}',
  locale text not null default 'en-US',
  status text not null default 'active' check (status in ('active', 'paused')),
  cadence text not null default 'weekly' check (cadence in ('daily', 'weekly', 'monthly')),
  last_run_at timestamptz,
  next_run_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.prompt_monitor_run (
  id uuid primary key default gen_random_uuid(),
  monitor_id uuid not null references public.prompt_monitor(id) on delete cascade,
  engine text not null,
  status text not null default 'queued' check (status in ('queued', 'running', 'complete', 'failed')),
  response_text text,
  mentioned_brands text[] not null default '{}',
  target_mentioned boolean,
  target_rank integer,
  cited_sources jsonb not null default '[]'::jsonb,
  error text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
```

Worker:
- Add `/prompt-monitor/run`.
- Use existing LLM provider clients where possible.
- Extract:
  - target mention boolean
  - brand order/rank
  - competitor mentions
  - URLs/sources/citations
  - response snippets

UI:
- `/projects/[id]/visibility`
- Visibility score = percent of completed runs where target is mentioned, weighted by rank.
- Prompt table with trend, top competitors, top sources, actual responses.
- "Create content from this gap" action that creates an `lx_keyword` row.
- "Audit cited source" action that runs CrawlProof on a source URL.

Acceptance criteria:
- User can add, pause, delete, and run prompt monitors.
- A monitor run stores raw response text and extracted brand/source data.
- Visibility dashboard shows brand mention trend and competitor distribution.
- Prompt gaps can seed content-plan topics.

Risks:
- Model output and source/citation availability differ by provider.
- Cost can grow quickly. Enforce entitlement caps and run frequency.

---

## 6. Phase 4 — Verified Backlink Exchange

### Goal

Move from "matcher plus ledger" to a verified exchange with statuses, credit/fair-share accounting, removal detection, and quality controls.

### Current state

`lib/lx/exchangeMatcher.ts` selects partner articles from opted-in sites and records `lx_backlink` rows. The current ledger is append-only and does not track verification, credit accounting, domain authority, removal, or retries.

### Schema changes

```sql
alter table public.lx_site
  add column if not exists authority_score integer,
  add column if not exists authority_provider text,
  add column if not exists authority_checked_at timestamptz,
  add column if not exists min_partner_authority integer not null default 0,
  add column if not exists backlink_credit_balance integer not null default 0;

alter table public.lx_backlink
  add column if not exists status text not null default 'pending'
    check (status in ('pending', 'verified', 'missing', 'removed', 'failed')),
  add column if not exists publication_status text not null default 'pending'
    check (publication_status in ('pending', 'published', 'failed')),
  add column if not exists source_article_url text,
  add column if not exists credits_applied integer not null default 0,
  add column if not exists verification_attempts integer not null default 0,
  add column if not exists last_verified_at timestamptz,
  add column if not exists next_verify_at timestamptz,
  add column if not exists revalidation_backlink_removed_at timestamptz,
  add column if not exists last_error text;

create table public.lx_backlink_credit_ledger (
  id uuid primary key default gen_random_uuid(),
  backlink_id uuid references public.lx_backlink(id) on delete set null,
  site_id uuid not null references public.lx_site(id) on delete cascade,
  delta integer not null,
  reason text not null check (reason in ('gave_link', 'received_link', 'refund_removed', 'manual_adjustment')),
  created_at timestamptz not null default now()
);
```

Matching updates:
- Candidate filters:
  - `backlinks_enabled = true`
  - active status
  - not inappropriate
  - authority score meets receiver threshold
  - candidate has not recently exchanged with this site
  - candidate has enough backlink credit balance if we enforce spend limits
- Ranking:
  - topic overlap/vector similarity
  - authority score
  - freshness
  - fair-share dampening
  - same-domain pair cooldown

Verification worker:
- Runs every hour.
- Fetches `source_article_url`.
- Parses anchors.
- Confirms target URL or target domain is linked.
- Marks `verified` and applies ledger entries.
- Retries pending links with exponential backoff.
- Rechecks verified links weekly.
- Marks `removed` and refunds/adjusts ledger when links disappear.

UI:
- Backlinks dashboard adds:
  - verified/pending/removed counts
  - credits earned/spent
  - partner authority
  - verification errors
  - recheck date

Acceptance criteria:
- A link is not counted as earned until verified.
- Removed links are detected and visible.
- Backlink tables distinguish pending, verified, missing, and removed.
- Matcher avoids repeat site pairs within configurable cooldown.

---

## 7. Phase 5 — Google Search Console Analytics

### Goal

Add GSC metrics so CrawlProof can report the same organic outcomes BLG markets: clicks, impressions, queries, pages, average position, and content/backlink impact.

### User stories

- As a user, I can connect Google Search Console.
- I can see clicks/impressions/rank movement for pages generated by CrawlProof.
- I can see which queries improved after content or backlink activity.

### Scope

Schema:

```sql
create table public.gsc_connection (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  site_url text not null,
  refresh_token_ciphertext text not null,
  status text not null default 'active',
  last_sync_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.gsc_daily_page_query (
  project_id uuid not null references public.projects(id) on delete cascade,
  day date not null,
  page_url text not null,
  query text not null,
  clicks integer not null default 0,
  impressions integer not null default 0,
  ctr numeric,
  position numeric,
  primary key (project_id, day, page_url, query)
);
```

UI:
- Add GSC panel under Performance or Stats.
- Page-level report for generated articles.
- Query table with before/after windows.

Acceptance criteria:
- OAuth stores encrypted refresh token.
- Daily sync dedupes by project/day/page/query.
- Generated `lx_article` pages can be joined to GSC rows by public URL.

---

## 8. Phase 6 — Reddit Opportunity Engine

### Goal

Build a Reddit opportunity workflow comparable to BLG, but keep posting manual or explicit to avoid spammy automation.

### User stories

- As a user, I can monitor keywords and see relevant Reddit discussions.
- I can see why a thread matters: search visibility, relevance, recency, engagement.
- CrawlProof drafts a helpful reply that naturally includes expertise and brand context.
- I decide whether to post.

### Scope

Schema:

```sql
create table public.reddit_opportunity (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  keyword text not null,
  subreddit text,
  post_id text not null,
  post_url text not null,
  title text not null,
  body_excerpt text,
  score integer,
  comment_count integer,
  relevance_score numeric,
  search_rank integer,
  status text not null default 'open' check (status in ('open', 'dismissed', 'responded')),
  discovered_at timestamptz not null default now(),
  unique(project_id, post_id)
);

create table public.reddit_reply_draft (
  id uuid primary key default gen_random_uuid(),
  opportunity_id uuid not null references public.reddit_opportunity(id) on delete cascade,
  draft_text text not null,
  status text not null default 'draft' check (status in ('draft', 'used', 'discarded')),
  created_at timestamptz not null default now()
);
```

Discovery:
- Use configured Reddit API credentials or existing social OAuth if available.
- Source keywords from:
  - `lx_keyword`
  - prompt monitors
  - project brand profile
  - competitors
- Rank by relevance, freshness, comments, and search visibility if available.

UI:
- `/projects/[id]/reddit`
- Opportunity list.
- Reply draft drawer.
- Mark responded/dismissed.

Acceptance criteria:
- No automatic Reddit posting in v1.
- Reply drafts include disclosure-safe brand context and avoid repetitive promo language.
- Opportunities can seed content-plan topics.

---

## 9. Phase 7 — CMS Connectors

### Goal

Reduce setup friction beyond webhooks.

### Initial connectors

1. WordPress REST API.
2. Shopify blog articles.
3. Webflow CMS items.
4. Ghost Admin API.

### Shared schema

```sql
create table public.cms_connection (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  provider text not null check (provider in ('webhook', 'wordpress', 'shopify', 'webflow', 'ghost')),
  status text not null default 'active',
  config jsonb not null default '{}'::jsonb,
  secret_ciphertext text,
  last_test_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

Publishing contract:

```ts
type PublishArticleInput = {
  articleId: string;
  title: string;
  slug: string;
  html: string;
  markdown: string;
  metaDescription: string | null;
  imageUrl: string | null;
  tags: string[];
  jsonLd: unknown;
};

type PublishArticleResult = {
  ok: boolean;
  publicUrl?: string;
  providerPostId?: string;
  error?: string;
};
```

Acceptance criteria:
- Existing webhook delivery keeps working.
- Each connector has a test-publish or connection-test step.
- Connector failure leaves article in retryable failed state.

---

## 10. Phase 8 — Public Proof And Reporting

### Goal

Close the trust gap. BLG's strongest public advantage is proof: case studies, logos, testimonials, and outcome metrics.

### Scope

Marketing:
- Add `/customers` or `/success-stories`.
- Add `/compare/babylovegrowth-ai` as an internal/SEO comparison page only if we can keep it factual and non-inflammatory.
- Add sample dashboard images:
  - audit report
  - content plan
  - prompt visibility
  - backlinks
  - AI referrals/bot crawls

Reporting:
- Add monthly "Autopilot report" email/PDF:
  - articles published
  - audits run
  - issues fixed
  - backlinks verified
  - AI referrals/crawls
  - GSC clicks/impressions
  - prompt visibility movement
  - next-month recommendations

Schema:

```sql
create table public.autopilot_monthly_report (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  period_start date not null,
  period_end date not null,
  report_markdown text not null,
  report_json jsonb not null default '{}'::jsonb,
  emailed_at timestamptz,
  created_at timestamptz not null default now(),
  unique(project_id, period_start)
);
```

Acceptance criteria:
- Every Autopilot project gets a monthly report.
- Report can be shared with a public token.
- Marketing site can link to sanitized sample reports.

---

## 11. Navigation Changes

Project tabs should become outcome-oriented:

Current:
- Getting Started
- Overview
- Performance
- Scans
- Stats
- Autoblog
- Social
- Repos
- Members

Proposed:
- Overview
- Plan
- Articles
- Visibility
- Backlinks
- Audits
- Analytics
- Outreach
- Fixes
- Settings

Mapping:
- Plan = `lx_keyword` calendar.
- Articles = `lx_article` history/preview/publish.
- Visibility = prompt monitors.
- Backlinks = exchange + guest posts.
- Audits = current Scans.
- Analytics = tracker + GSC.
- Outreach = Reddit + social posting.
- Fixes = GitHub apply-fix + tracker install + technical tasks.

Keep legacy URLs as redirects.

---

## 12. Build Sequence

1. **Phase 1: Entitlements and pricing copy**
   - Add subscription tables.
   - Add plan/usage cards.
   - Wire article quota consumption.

2. **Phase 2: Content Plan**
   - Add `lx_keyword` metadata columns.
   - Build `/autoblog/plan`.
   - Add reschedule/replace/instructions endpoints.
   - Feed instructions into article generation.

3. **Phase 3: Prompt Visibility**
   - Add prompt monitor schema.
   - Add worker runner and extraction.
   - Build visibility dashboard.
   - Add "create topic from prompt gap."

4. **Phase 4: Backlink Verification**
   - Extend `lx_backlink`.
   - Build verification worker.
   - Add backlink status/credit UI.
   - Add fair-share terms to matcher.

5. **Phase 5: GSC**
   - Add OAuth and sync.
   - Build organic performance views.
   - Join generated articles to GSC.

6. **Phase 6: Reddit**
   - Add discovery worker.
   - Build opportunities UI and drafts.
   - Feed opportunities into plan.

7. **Phase 7: CMS connectors**
   - Add `cms_connection`.
   - Implement WordPress first, then Shopify/Webflow/Ghost.
   - Abstract publisher interface.

8. **Phase 8: Proof**
   - Monthly report generator.
   - Public sample reports.
   - Success-story pages.

---

## 13. Non-Goals

- Fully automatic Reddit posting.
- Guaranteed ranking/traffic promises.
- Hidden backlink placements.
- Replacing credits entirely.
- Building every CMS connector before validating WordPress demand.
- Agency/white-label dashboards beyond what `docs/agency-prd.md` already covers.

---

## 14. Key Metrics

Activation:
- Percentage of new projects that complete audit + tracker + content plan.
- Time from signup to first scheduled article.
- Time from signup to first published article.

Content:
- Articles generated per active project per month.
- Preview approval rate.
- Failed delivery rate.

Visibility:
- Prompt monitors created per project.
- Target-brand mention rate.
- Prompt visibility score trend.

Backlinks:
- Verified backlinks per project per month.
- Pending-to-verified conversion rate.
- Removed-link rate.
- Same-pair repeat rate.

Business:
- Autopilot subscription conversion.
- Credit overage revenue.
- Churn by feature usage.

---

## 15. Open Questions

1. Which payment provider should manage subscriptions if CoinPay remains credits-only?
2. Should Autopilot include all LLM audit engines or keep those as credit-based scans?
3. How many prompt-monitor engines are included by default?
4. What authority provider do we use for backlink scoring: DataForSEO, Ahrefs, Moz, or our own observed signals?
5. Do we allow autopublish by default, or default to preview/approve?
6. Should verified backlink credits be independent from scan/article credits?
7. Which CMS connector should ship first after webhook: WordPress or Shopify?

