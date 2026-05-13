# Crawlproof Link Exchange — PRD

> Goal: add a much-simpler **outrank.so**-style offering to crawlproof.com — AI auto-publishes blog posts to the customer's site via webhook, and each generated article includes N outbound backlinks chosen from a network of other crawlproof customers. Everything is driven from a domain + a few keywords.
>
> This PRD is grounded in live reverse-engineering of outrank.so performed 2026-05-13 (logged in as `ettinger@gmail.com`, product ThreatCrush). Screenshots and captured API responses are in `/tmp/outrank-recon/`.

---

## 1. How outrank.so does it (observed)

### 1.1 Stack
- Next.js (App Router) marketing+dashboard on `www.outrank.so`.
- Supabase (project `dgybucdtdywuftkrdbgd`) aliased as `api.outrank.so` for `/auth/v1/*` and `/rest/v1/*`.
- Direct Supabase REST for raw CRUD, custom Next.js `/api/*` routes for composed business logic (backlink matching, DR lookups, webhook dispatch).
- Ahrefs API server-side for Domain Rating (`GET /api/domain-rating?productId=&organizationId=`).

### 1.2 Tenancy model
```
organizations 1─* users
organizations 1─* products            # one per customer domain ($89–99 / mo each)
products      1─1 integrations         # the configured webhook / wordpress / etc
products      1─* scheduled_keywords   # editorial calendar
products      1─* articles
products      1─1 output_settings_presets
products      1─1 backlink_credits     # credit balance
products      *─* backlinks            # link given/received in the exchange
```
The active product is selected client-side via a `current_product_id` cookie.

### 1.3 Key per-product fields (from `GET /rest/v1/products`)
- `url`, `sitemap_url`, `blog_root_url`, `niche`, `target_audiences[]`, `description`
- `integration_id`, `integration_type` ("webhook")
- `backlinks_enabled`, `min_backlink_domain_rating` (default 5), `prioritize_backlinks`
- `monthly_backlink_credits`, `backlink_next_renewal_date`
- `internal_links_source: "sitemap"`, `links_for_backlinks_sitemap_url`
- `daily_article_count: 1`, `article_publishing_days` (e.g. weekdays-only)
- `inappropriate_content`, `checked_on_inappropriate_content` (auto moderation)

### 1.4 Article generation knobs (`output_settings_presets`)
```
tone_and_style, language, keyword_region,
internal_links: 3,            # # of links to your own pages
external_links_count: 3,      # # of backlink-exchange links injected
auto_publish: true,           # if true, webhook fires automatically on completion
image_type, image_style, featured_image_style,
table_of_contents, mention_similar_products,
is_first_person_enabled, is_cta_included, is_video_included,
brand_color, global_article_prompt
```

### 1.5 Keyword research (`scheduled_keywords`)
Each row has:
- `keyword`, `search_volume`, `difficulty`, `local_scheduled_date`, `status`
- `generation_source: "competitors"`, `generation_context: "www.crowdstrike.com"`
- `generation_filters: { competitors: [...], target_audiences: [...] }`
- `article_type: "guide"`, `article_subtype: "explainer"`, `type_confidence: 0.92`
- `type_metadata.contentFocus`, `type_metadata.visualElements`
- `quality_questions`: 4 free-text prompts the user can answer to inject first-person expertise (e.g. *"Which repetitive security task did you automate first?"*).

Drag/drop on the calendar fires `POST /api/keywords/reschedule`.

### 1.6 Webhook publish (from `/docs/webhook`)
- **POST** to the customer's URL
- Header: `Authorization: Bearer {ACCESS_TOKEN}` (a static secret minted at integration-create time — no HMAC)
- Body:
```json
{
  "event_type": "publish_articles",
  "timestamp": "2026-05-13T16:35:21Z",
  "data": {
    "articles": [{
      "id": "uuid",
      "title": "string",
      "slug": "string",
      "content_markdown": "string",
      "content_html": "string",
      "meta_description": "string",
      "image_url": "https://...",
      "tags": ["..."],
      "created_at": "ISO-8601"
    }]
  }
}
```

### 1.7 Backlink Exchange — the actual algorithm (deduced)

Endpoints in play:
- `GET /api/domain-rating?productId&organizationId` → `{ rating: 8 }`
- `GET /api/backlinks/credits?productId` → `{ credits: 24, dailyCreditsUsed: 145, dailyLimit: 150, monthlyCredits, nextRenewalDate }`
- `GET /api/backlinks/performance?productId&organizationId` → `{ totalBacklinks, uniqueSources, verifiedBacklinks, pendingBacklinks, refundedBacklinks }`
- `GET /api/backlinks/list/new?productId&organizationId&page&pageSize`
- `GET /api/backlinks/list/unverified?productId&countOnly&status=not_verified&createdBefore=...`
- `GET /api/backlinks/list?productId&organizationId`

A captured backlink row:
```json
{
  "id": "25590cc5-...",
  "created_at": "2026-05-13T10:12:37Z",
  "mentioned_url": "https://threatcrush.com/blog/application-security-software",
  "source_article_id": "17d213f3-...",
  "source_article_url": "https://tekk.coach/build/vibe-coding-security-audit/",
  "status": "not_verified" | "verified",
  "publication_status": "pending" | "published",
  "credits_applied": 27,
  "verification_attempts": 1,
  "last_verified_at": "...",
  "revalidation_backlink_removed_at": null,
  "source_product": { "id":"...","name":"Robotomail","url":"https://robotomail.com","blog_root_url":"https://robotomail.com/blog","domain_rating": 27 },
  "article": { "id":"...","title":"...","url":"...","slug":"...","status":"published" }
}
```

**Pricing rule**: `1 credit = 1 DR point`. `credits_applied: 27` on a row whose `source_product.domain_rating: 27` confirms it. The **receiver** of a backlink pays credits equal to the **giver's** DR. The giver earns credits equal to the receiver's DR (so high-DR sites are net-net beneficiaries of linking out to low-DR sites only if many do it — outrank papers over this with monthly stipends + a paid "priority" boost).

**Matching pipeline** (when generating an article for product `P` with keyword `K`):
1. Candidate set = all products in the network where:
   - `backlinks_enabled = true`
   - `status = active`
   - `inappropriate_content = false`
   - `domain_rating ≥ P.min_backlink_domain_rating`
   - `dailyCreditsUsed < dailyLimit` (avoid burnout)
2. Rank by topical relevance — almost certainly cosine similarity between
   `K + P.target_audiences` and each candidate's `(description, target_audiences, niche, recent article titles)`. The captured filters echo this (`generation_filters.competitors`, `target_audiences`).
3. Take top `external_links_count` (default 3).
4. Inject those URLs into the article body as contextual anchors during AI generation (most likely passed into the LLM prompt with "link these phrases to these URLs").
5. Article publishes via webhook → `publication_status: published`.

**Verification crawler** (offline worker):
- Polls each `mentioned_url` (the published article on the receiver's blog).
- Looks for an `<a href>` pointing at any participating product's domain.
- On hit: `status: verified`, increment giver credits, decrement receiver credits by `source_product.domain_rating`.
- On miss after N attempts: row stays `not_verified`, no credits flow.
- Periodic re-check; if link is later removed → `revalidation_backlink_removed_at` set, `refundedBacklinks++`.

### 1.8 Internal linking (`/dashboard/linking`)
- Source = sitemap.xml of the customer's site (`link_detection_status: success`, `link_detection_last_run`).
- The crawler discovers internal URLs; the article generator injects `internal_links: 3` of them per article using topical match.
- Paid tier unlocks per-page priority + custom anchor text.

---

## 1A. What outrank uses for keyword data (and our path)

Captured calls show two server-side proxies the dashboard hits:

```js
// Per-keyword on-demand
POST /api/keywords/info
  body: { keyword, keyword_region }   // e.g. "us"
  resp: { data: { searchVolume, difficulty } }

// Bulk on paste/import
POST /api/keywords/bulk-process
  body: { keywords: [...] }
  resp: { data: [...] }
```

The provider is hidden behind the proxy (no Ahrefs/DataForSEO/Semrush strings bundled in their JS) — they bought a wholesale data feed and resell volume + difficulty as an internal metric. Industry-standard guess: **DataForSEO** (every captured field matches their Google Ads schema 1:1, and outrank's pricing tier wouldn't sustain Ahrefs's API rates).

**We will use DataForSEO directly.** See §15 for the integration.

---

## 2. The Crawlproof version — scope

### 2.1 Positioning
- Sold as an **add-on** inside crawlproof.com, not a separate brand.
- Single price tier. No "human-curated" upsell, no premium image presets, no directory submission, no managed service.
- One **site per user** to start (no multi-product workspaces; can be lifted later).
- Customer brings: a domain, a sitemap URL, and a webhook endpoint (or uses our turnkey WordPress plugin in a later release).

### 2.2 What we **explicitly drop** vs outrank
| outrank.so | crawlproof v1 |
|---|---|
| WP, Webflow, Notion, Wix, Shopify, Framer, Ghost, WP.com, Next.js native connectors | **Webhook only** |
| Ahrefs DR weighting | **Flat 1:1** credits (1 link out = 1 link in earned) |
| Per-day spend cap, monthly stipends, priority upgrade | **Earn-as-you-go** only |
| Multi-product orgs, team invites, role-based access | **One site / user**, single role |
| Premium image presets, brand color, video embeds, infographics | **Stock images + 1 featured image** |
| Content Planner calendar w/ drag-drop, competitor mining, quality questions | **Auto-schedule** (cron, 1/day) |
| Internal linking config UI, priority anchors | **Auto** (sitemap → topical match) |
| Auto moderation, French SAS billing, Rewardful affiliates, Crisp chat, PostHog | Reuse existing crawlproof billing/auth |

### 2.3 What we **keep**
1. Domain + sitemap + keywords → AI article generation
2. Webhook auto-publish with Bearer secret
3. Backlink exchange: every article carries N outbound links to other members
4. Verification crawler that confirms the link landed on the receiver's published page
5. Pause/resume per site
6. A dashboard with: article history, backlinks earned, credit balance, "next publish at"

---

## 3. Data model (Supabase)

New migration; everything namespaced `lx_` so it doesn't collide with existing tables.

```sql
-- A site enrolled in the exchange (1 per user for v1)
create table lx_site (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  domain text not null,                       -- "threatcrush.com"
  url text not null,                          -- "https://threatcrush.com"
  blog_root_url text not null,                -- "https://threatcrush.com/blog"
  sitemap_url text not null,
  niche text,                                 -- free-text or controlled vocab
  target_audiences text[] not null default '{}',
  description text not null default '',
  status text not null default 'active' check (status in ('active','paused','flagged')),
  backlinks_enabled boolean not null default true,
  external_links_per_article smallint not null default 3,
  internal_links_per_article smallint not null default 3,
  daily_article_count smallint not null default 1,
  publish_days smallint[] not null default '{1,2,3,4,5}', -- ISO weekdays
  webhook_url text,
  webhook_secret text,                        -- bearer token we generate
  credit_balance integer not null default 0,
  embedding vector(1536),                     -- pgvector for matching (description + audiences)
  last_sitemap_fetch_at timestamptz,
  sitemap_status text,
  inappropriate_content boolean default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index on lx_site(user_id);      -- 1 per user in v1
create unique index on lx_site(lower(domain));

-- Pages discovered from the sitemap that articles can link to (internal & exchange targets)
create table lx_site_page (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references lx_site(id) on delete cascade,
  url text not null,
  title text,
  description text,
  embedding vector(1536),
  is_blog_post boolean not null default false,
  last_seen_at timestamptz not null default now()
);
create unique index on lx_site_page(site_id, url);

-- Keywords scheduled for content
create table lx_keyword (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references lx_site(id) on delete cascade,
  keyword text not null,
  scheduled_for date not null,
  status text not null default 'queued' check (status in ('queued','generating','published','failed','skipped')),
  source text not null,                       -- 'manual' | 'auto'
  article_id uuid,                            -- backref once generated
  created_at timestamptz not null default now()
);
create index on lx_keyword(site_id, scheduled_for);

-- Generated articles
create table lx_article (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references lx_site(id) on delete cascade,
  keyword_id uuid references lx_keyword(id),
  title text not null,
  slug text not null,
  meta_description text not null,
  content_markdown text not null,
  content_html text not null,
  image_url text,
  tags text[] not null default '{}',
  published_at timestamptz,                   -- when webhook fired successfully
  webhook_response_code int,
  status text not null default 'draft' check (status in ('draft','generating','ready','publishing','published','failed')),
  created_at timestamptz not null default now()
);
create index on lx_article(site_id, published_at desc);

-- The backlink exchange ledger
create table lx_backlink (
  id uuid primary key default gen_random_uuid(),
  giver_site_id uuid not null references lx_site(id),        -- whose article carries the link
  receiver_site_id uuid not null references lx_site(id),      -- whose URL is being linked to
  giver_article_id uuid not null references lx_article(id),
  receiver_page_url text not null,                            -- the exact URL inserted
  anchor_text text not null,
  status text not null default 'pending'
    check (status in ('pending','verified','removed','failed')),
  verification_attempts smallint not null default 0,
  last_verified_at timestamptz,
  removed_at timestamptz,
  credits_applied integer not null default 0,                  -- +1 to giver when verified
  created_at timestamptz not null default now()
);
create index on lx_backlink(receiver_site_id, status);
create index on lx_backlink(giver_site_id, status);

-- Append-only audit log of credit movement (so we can refund cleanly)
create table lx_credit_ledger (
  id bigserial primary key,
  site_id uuid not null references lx_site(id),
  backlink_id uuid references lx_backlink(id),
  delta integer not null,            -- +1 on verified-give, -1 on revoke/removed
  reason text not null,              -- 'verified_give' | 'removed_revoke' | 'manual_grant'
  created_at timestamptz not null default now()
);
```

RLS: every `lx_*` table is `user_id`-scoped through `lx_site.user_id`. Service role for the worker bypasses RLS.

---

## 4. Backlink-matching algorithm (v1)

When generating an article for site `S` with keyword `K`:

1. Compute `query_embedding = embed("{K}. {S.description}. Audiences: {S.target_audiences.join(', ')}")`.
2. Candidate set:
   ```sql
   select p.*, s.domain, s.credit_balance
   from lx_site_page p
   join lx_site s on s.id = p.site_id
   where s.id <> :S.id
     and s.status = 'active'
     and s.backlinks_enabled = true
     and s.inappropriate_content = false
     and p.is_blog_post = true
   ```
3. Rank by `(1 - (p.embedding <=> :query_embedding))` (cosine similarity in pgvector), break ties by `lx_site.credit_balance ASC` to give low-credit sites priority (fairness).
4. Constrain to at most **one link per receiver site per article** so we spread credits.
5. Take top `S.external_links_per_article` (default 3).
6. Pass the selected `(url, anchor_idea)` tuples into the LLM prompt:

```
You are writing a blog post for {S.domain}.
Topic: {K}
Audience: {S.target_audiences.join(', ')}

You MUST insert exactly {N} outbound contextual links. Use them inline where each
is genuinely relevant. Do NOT mention them in a "further reading" list. They must
appear in the natural flow of the prose.

Outbound links (URL — suggested anchor context):
1. {url_1} — {receiver_1.title}
2. {url_2} — ...
3. {url_3} — ...
```
7. After generation, parse the article HTML with `cheerio`, confirm all N URLs are present as `<a href>`, and create `lx_backlink` rows with `status='pending'`.

**Internal links** are chosen the same way but candidates are restricted to `lx_site_page` where `site_id = S.id` and `is_blog_post = false`.

---

## 5. Verification crawler (worker)

Runs every 10 minutes via the existing `worker/` runtime.

```
for each backlink in lx_backlink where status='pending' and verification_attempts < 6:
  if backlink.giver_article.published_at is null: continue
  fetch backlink.giver_article.public_url (constructed from giver_site.blog_root_url + slug)
  parse with cheerio
  if <a href=...> matches receiver_page_url (exact or normalized):
    backlink.status = 'verified'
    backlink.credits_applied = 1
    insert into lx_credit_ledger (site_id=giver, delta=+1, reason='verified_give', backlink_id=...)
    update lx_site set credit_balance = credit_balance + 1 where id=giver
  else:
    backlink.verification_attempts += 1
    if attempts >= 6: backlink.status = 'failed'
  backlink.last_verified_at = now()
```

A second pass re-checks `verified` rows weekly to catch silent removals → `status='removed'`, refund via opposite ledger entry.

We use `fetch` with a 10s timeout, gzip, and respect robots.txt for the giver's `blog_root_url`. URL match normalization: lowercase host, strip trailing `/`, drop `utm_*` params.

---

## 6. AI generation pipeline

1. **Keyword research** (auto): for each site once a week, call `POST /api/lx/keywords/generate` which uses Claude (already in deps) to expand seed niche/audiences into 30 candidate keywords. Insert into `lx_keyword` as `queued` and bucket onto `publish_days` over the next month.
2. **Article generation** (cron `daily_article_count` times per day, on `publish_days` only):
   1. Pick the next queued `lx_keyword`.
   2. Resolve internal + external link targets (§4).
   3. Render LLM prompt → markdown.
   4. Render HTML (`marked` already in deps).
   5. Generate featured image (OpenAI Images or a stock-image lookup — TBD; image generation is more expensive so v1 should default to stock).
   6. Store article in `lx_article`, set `status='ready'`.
3. **Publish step** (immediately after generate, in same job): fire webhook (§7); on `2xx` set `status='published'`, `published_at=now()`. On failure mark `status='failed'`, store response code; retry with backoff 3 times, then surface in dashboard.

LLM call uses Claude Sonnet 4.6 for body, with prompt caching on the system prompt and per-site context.

---

## 7. Webhook contract (intentional clone of outrank's shape)

We deliberately mirror outrank's payload so customers already running an outrank-compatible endpoint can repoint at us without code changes. Different `event_type` namespace though, to avoid masquerading.

**Request:**
- `POST {site.webhook_url}`
- Headers:
  - `Content-Type: application/json`
  - `Authorization: Bearer {site.webhook_secret}`
  - `User-Agent: Crawlproof-LinkExchange/1.0`
  - `X-Crawlproof-Delivery: {uuid}` (idempotency key)

**Body:**
```json
{
  "event_type": "lx.publish_article",
  "timestamp": "2026-05-13T16:35:21Z",
  "data": {
    "article": {
      "id": "uuid",
      "title": "string",
      "slug": "string",
      "content_markdown": "string",
      "content_html": "string",
      "meta_description": "string",
      "image_url": "https://...",
      "tags": ["..."],
      "outbound_links": [
        { "url": "https://...", "anchor": "..." }
      ],
      "created_at": "ISO-8601"
    }
  }
}
```

Retry: at-least-once, 3 attempts at 0s / 30s / 5min. Idempotent on `X-Crawlproof-Delivery`.

We also ship a tiny `examples/webhook-receiver/` snippet (Next.js route handler) so customers can drop it in.

---

## 8. UI surface (Next.js, under `app/(app)/link-exchange/`)

Three routes is enough for v1:

| Route | Shows |
|---|---|
| `/link-exchange/setup` | One-page onboarding wizard: domain → sitemap detect → niche/audiences → webhook url + auto-generated secret → "Run first detection" |
| `/link-exchange` | Dashboard: credit balance, articles published this month, backlinks earned (verified vs pending), upcoming queue (next 7 days), pause toggle |
| `/link-exchange/history` | Table of articles + per-article outbound links and their verification status |

No drag-drop calendar in v1 — just a list. No premium tiers in v1.

---

## 9. API surface (Next.js route handlers)

All under `app/api/lx/`:

- `POST /api/lx/site` — create/update site config (idempotent on user)
- `POST /api/lx/site/regenerate-secret` — rotate webhook bearer
- `POST /api/lx/sitemap/refresh` — kick a sitemap re-fetch (enqueues worker job)
- `GET  /api/lx/dashboard` — aggregated stats for the dashboard
- `GET  /api/lx/articles` — paginated list
- `POST /api/lx/keywords` — manual add
- `POST /api/lx/pause`, `POST /api/lx/resume`

Worker-only (signed via `CRAWLPROOF_WORKER_KEY`):
- `POST /api/lx/internal/generate` — trigger generation for one keyword (called by cron)
- `POST /api/lx/internal/verify-batch` — verification crawler pass

---

## 10. Worker jobs

Reuse `worker/index.ts`. Add to the existing job dispatcher:

| Job | Schedule | Purpose |
|---|---|---|
| `lx.sitemap.crawl` | daily / on-demand | refresh `lx_site_page` from sitemap, embed pages |
| `lx.keywords.research` | weekly per site | generate next 30 keywords |
| `lx.article.generate` | hourly cron, fans out to sites whose next publish slot is due | produces 1 article |
| `lx.webhook.deliver` | inline + retry queue | post to customer endpoint |
| `lx.backlink.verify` | every 10 min | crawl giver articles, mark verified |
| `lx.backlink.revalidate` | weekly | re-check `verified` rows for removal |
| `lx.site.moderate` | on sitemap refresh | run classifier (Claude) to set `inappropriate_content` |

---

## 11. Cold-start problem

The exchange is worthless with only 1 member. Mitigation:

1. Seed the `lx_site_page` table with **crawlproof.com**'s own blog as a first network participant. Every customer's first articles can link out to crawlproof guides; we get free distribution.
2. Until the network has ≥10 active sites, the matcher may return fewer than 3 external links — articles publish anyway with whatever was found; UI tells the user "Backlink Exchange will grow more aggressive as more members join."
3. Refer-a-site coupon: a free month for each referred site that activates the exchange.

---

## 12. Risks & mitigations

- **Spammy link graph / Google penalty.** Mitigations: per-receiver-per-article cap (§4.4); topical matching only (no random); soft cap of one link per source-receiver pair per 30 days; `lx.site.moderate` flag.
- **Webhook secret leakage.** Rotation endpoint; secrets stored hashed at rest (compare hash on outbound — though Bearer is plaintext on the wire by definition, this only matters for our DB).
- **Crawler getting blocked by Cloudflare / receiver's anti-bot.** Use the existing crawlproof crawler infra; respect robots.txt; back off on 403/429.
- **AI generates unrelated content / hallucinated links.** Post-generation validator: confirm every outbound URL is present in `lx_site_page` and the anchor surrounds the URL. Reject and regenerate if not.
- **Concurrent credit updates.** All credit deltas go through `lx_credit_ledger` inserts inside a single SQL transaction with `select ... for update` on the affected `lx_site` row.

---

## 13. Out of scope for v1 (explicit non-goals)

- Multi-site workspaces
- DR-weighted credits (flat 1:1)
- Native WP/Webflow/etc plugins (webhook only)
- Drag-drop content calendar
- Custom anchor-text priorities
- Internal-team roles / invites
- Premium image generation tiers
- Directory submission, human-curated service, free-tools-builder
- API for end-customers (admin dashboard only)

---

## 14. Build sequence

1. **Migration** — `supabase/migrations/NNNN_link_exchange.sql` (§3) + pgvector extension if not enabled.
2. **Site setup flow** — `/link-exchange/setup` wizard + `POST /api/lx/site`.
3. **Sitemap crawler** — `worker` job + `lx_site_page` population (use existing `cheerio`).
4. **Embedding pipeline** — OpenAI embeddings for descriptions + pages.
5. **Keyword research worker** — Claude prompt + insert into `lx_keyword`.
6. **Article generator** — Claude prompt with internal+external link slots, output to `lx_article`.
7. **Webhook delivery** — `lx.webhook.deliver` job + retry table.
8. **Verification crawler** — `lx.backlink.verify` job.
9. **Dashboard UI** — 3 routes (§8).
10. **Crawlproof's own site** seeded as first network participant.
11. Soft-launch to existing customers as a free beta in exchange for activating their sitemap on the network.

---

## 15. Keyword data source — DataForSEO Google Ads API

### 15.1 Why DataForSEO

- Same data Google's own Keyword Planner returns (search volume, CPC, competition) — and DataForSEO computes a **Keyword Difficulty** score derived from real SERP analysis on top.
- Pay-as-you-go, no minimum, no subscription.
- **Standard queue**: `$0.05` per task, batch up to 1,000 keywords per task, results in <5 min.
- **Live mode**: `$0.075` per task, same batch size, <30s.
- For our load: 1 site × ~30 keywords/month × 1,000 customers = 30,000 keyword lookups = **~$1.50/month** if we batch (one 1,000-keyword task per region per day covers everyone). Even at one task per site per month: $50/M ≈ $1.50.
- One vendor covers search volume + KD + SERP scrape + Google Trends, so we don't pile up integrations.

The Google Ads Keyword Planner direct API is technically free but: (a) requires an Ads account in good standing with active spend, (b) returns volume as **buckets** (e.g. "10K–100K") not exact numbers, (c) is rate-limited. Not viable for a SaaS product.

### 15.1a Validated response (2026-05-13 live call)

Seed: `["threat detection"]`, sort_by `relevance`, live mode. **Cost: $0.075 for 1 task → 577 related keywords**, returned in 4.6 seconds.

Response envelope:
```json
{
  "status_code": 20000, "status_message": "Ok.",
  "cost": 0.075, "tasks_count": 1,
  "tasks": [{
    "status_code": 20000, "cost": 0.075,
    "result": [
      {
        "keyword": "threat detection",
        "location_code": null, "language_code": null,
        "search_partners": false,
        "competition": "LOW", "competition_index": 11,
        "search_volume": 2400,
        "low_top_of_page_bid": 1.36, "high_top_of_page_bid": 17.41,
        "cpc": 17.2,
        "monthly_searches": [
          { "year": 2026, "month": 3, "search_volume": 4400 },
          { "year": 2026, "month": 2, "search_volume": 1900 },
          ...12 months total
        ],
        "keyword_annotations": { "concepts": null }
      },
      ...576 more rows
    ]
  }]
}
```

**Sample top-relevance rows for "threat detection" seed:**
```
2900   LOW   managed detection and response
6600   LOW   network intrusion detection system
 590   LOW   identity threat detection and response
 880   LOW   ransomware detection
 480   LOW   insider threat detection
 880   LOW   threat detection and response
 480   LOW   cloud detection and response
1600   LOW   managed detection and response services
```

**Gotcha — filter outliers.** DataForSEO occasionally returns junk rows with implausibly high volume + `competition_index = 1` (in this sample, `intrusion prevention service` reported 1,000,000 searches/month with `cpc = $1.76`). Our cleaning pass should drop rows where any of:
- `competition_index <= 2 AND search_volume > 100000`
- `cpc < 0.5 AND search_volume > 50000`
- `keyword` length > 80 chars or contains URL-like substrings

Keep `sort_by: "relevance"` — sorting by volume surfaces those outliers at the top. After filtering, take top 30 by `(relevance_rank * 0.6 + log(search_volume) * 0.4)`.

### 15.2 Endpoints we'll use

| DataForSEO endpoint | Purpose | Mode |
|---|---|---|
| `POST /v3/keywords_data/google_ads/keywords_for_keywords/live` | **Expand a seed keyword into related keywords with volume + CPC + 12-month history. The primary idea engine.** ✅ live-call confirmed | live, $0.075 |
| `POST /v3/keywords_data/google_ads/search_volume/live` | Volume + CPC for a batch of up to 1,000 known keywords (no idea expansion) | live, $0.075 |
| `POST /v3/keywords_data/google_ads/keywords_for_site/live` | Generate keyword ideas from a competitor URL — replaces outrank's "competitor mining" | live, $0.075 |
| `POST /v3/dataforseo_labs/google/keyword_difficulty/live` | KD score (0-100), needed because the Google Ads `competition_index` only goes 0/1/2 buckets | live, $0.0001/keyword |
| `POST /v3/serp/google/organic/task_post` | (Optional) Capture top-10 SERP for a keyword — for future SERP-driven outlines | async |

**Live vs `task_post`/`task_get`.** The `live` variant returns in <5s, costs slightly more ($0.075 vs $0.05), and removes the polling step. For our usage pattern (one batch per site per week), **live is the right default** — we don't need the $0.025/task savings and the simpler control flow is worth it.

If we ever batch >10k keywords at a time, switch that one flow to `task_post` + a `POST /api/lx/internal/dataforseo-callback` webhook.

### 15.2a Worked examples (both verified live against the API on 2026-05-13)

**A. Idea expansion — `keywords_for_keywords/live`.** Use when we have a seed keyword (or a few) and want a fan-out of related queries. Returns up to ~700 keywords per task.

```bash
curl --request POST 'https://api.dataforseo.com/v3/keywords_data/google_ads/keywords_for_keywords/live' \
  --header "Authorization: Basic $(printf '%s' "$DATAFORSEO_LOGIN:$DATAFORSEO_PASSWORD" | base64)" \
  --header 'Content-Type: application/json' \
  --data-raw '[{"keywords":["threat detection"], "sort_by":"relevance"}]'
```

Cost: `$0.075` per task. Verified: seed `["threat detection"]` → **577 rows** in 4.6s.

**B. Volume lookup — `search_volume/live`.** Use when we already have a list of candidate keywords (e.g. the user typed them in, or we expanded with autocomplete) and just need volume/CPC/seasonality. Up to 1,000 keywords per task, all priced as one task.

```bash
curl --request POST 'https://api.dataforseo.com/v3/keywords_data/google_ads/search_volume/live' \
  --header "Authorization: Basic $(printf '%s' "$DATAFORSEO_LOGIN:$DATAFORSEO_PASSWORD" | base64)" \
  --header 'Content-Type: application/json' \
  --data-raw '[{"keywords":["threat detection"], "sort_by":"relevance"}]'
```

Cost: `$0.075` per task regardless of batch size 1-1,000. Verified: 1 keyword → 1 row in 3.2s. Same row schema as A but no idea fan-out.

**Verified row example** (from B, identical fields appear in A):
```json
{
  "keyword": "threat detection",
  "search_volume": 2400,
  "competition": "LOW",
  "competition_index": 11,
  "cpc": 17.2,
  "low_top_of_page_bid": 1.36,
  "high_top_of_page_bid": 17.41,
  "monthly_searches": [
    {"year": 2026, "month": 3, "search_volume": 4400},
    {"year": 2026, "month": 2, "search_volume": 1900},
    {"year": 2026, "month": 1, "search_volume": 1600}
    // …12 months total
  ]
}
```

**When to use which** in the keyword pipeline:
1. **Seed → expand**: pick site's seed topic(s) (from `lx_site.niche` + audit summary). Call `keywords_for_keywords/live` once per seed. Filter outliers (§15.1a). Take top 30 by relevance.
2. **User-supplied list**: when a customer pastes their own keywords into the dashboard, call `search_volume/live` to backfill volume/CPC. No expansion.
3. **Competitor mining**: call `keywords_for_site/live` with a competitor URL — same response shape, one DataForSEO task per competitor.

All three are mode-`live` and share `Authorization` and response envelope — the worker can have one DataForSEO client class with three thin methods.

### 15.2b Credentials

DataForSEO uses HTTP Basic Auth: `Authorization: Basic base64(login:password)`.
- Store in env: `DATAFORSEO_LOGIN`, `DATAFORSEO_PASSWORD`.
- Never bundle in client JS (we hit the API from the worker only).
- Add a `DATAFORSEO_USAGE` Stripe metric in dashboards: every task adds `cost` to a Postgres `lx_dataforseo_usage(task_id, endpoint, cost, created_at)` ledger so we can see spend per feature without logging into DataForSEO's console.

### 15.3 Caching

Add a table to amortize cost across customers — most keywords overlap.

```sql
create table lx_keyword_metrics (
  id bigserial primary key,
  keyword text not null,
  region text not null default 'us',           -- ISO country code
  search_volume integer,
  difficulty smallint,                          -- 0–100 from /dataforseo_labs/.../keyword_difficulty
  cpc_usd numeric(10,2),
  competition text,                             -- 'LOW' | 'MEDIUM' | 'HIGH' (Google Ads bucket)
  competition_index smallint,                   -- 0-100 numeric
  low_top_of_page_bid numeric(10,2),
  high_top_of_page_bid numeric(10,2),
  monthly_searches jsonb,                       -- 12-month history [{year, month, search_volume}]
  source text not null default 'dataforseo',
  fetched_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '60 days'
);
create unique index on lx_keyword_metrics(lower(keyword), region);
create index on lx_keyword_metrics(expires_at);
```

Worker pulls a single batched task per region per day for any keyword whose `expires_at < now()`. 60-day TTL because search volume is sticky.

### 15.4 Free augmentation: Google Search Console

For users who connect GSC (outrank already had `search_console_connections` in their schema — copy the pattern), we get **first-party impression and click data for their own keywords for free**. That data is more valuable than third-party estimates for *that site's* existing pages and lets us:
- Prioritize keyword expansion around terms the user already ranks for on page 2-3 (quick wins).
- Skip DataForSEO calls for keywords GSC already tells us about.

Implementation: standard Google OAuth, `searchAnalytics.query` endpoint, fetched daily and stored in `lx_gsc_keyword`.

### 15.5 Free idea generation: Google Autocomplete

`GET https://suggestqueries.google.com/complete/search?client=firefox&q={seed}` returns the same 10 autocomplete suggestions Google's search box shows — unauthenticated, free, no API key. Use it as the **first step** of keyword research: expand a seed into ~10 related queries, then send the full batch to DataForSEO for volume scoring. This cuts DataForSEO calls roughly in half versus asking DataForSEO to expand ideas itself.

### 15.6 Estimated COGS per site per month

| Item | Calls | Cost |
|---|---|---|
| Keyword research (30 keywords) | 1 DataForSEO batch task | $0.05 |
| KD scoring (30 keywords) | 30 × $0.0001 | $0.003 |
| Cache hit rate (60-day TTL, 70% overlap target) | — | reduces above by ~70% over time |
| Article generation (Claude Sonnet 4.6, 2k input + 4k output) | 1/day × 30 | ~$0.50 |
| Featured image (stock-image lookup) | 30 | ~$0 |
| Webhook delivery | 30 | ~$0 |
| Verification crawl | ~100 requests/site | ~$0 |
| **Total** | | **< $0.60 / site / month** |

Selling at 1 credit per article + 1 credit per backlink (and crediting a generation only when network gives or receives — see §16), this stays comfortably profitable.

---

## 16. Pricing model

> **1 credit per blog post published.** **1 credit per backlink received.**

### 16.1 What gets charged

| Event | Credits charged | When |
|---|---|---|
| `lx_article` reaches `status='published'` (webhook 2xx) | **1** | At publish time, against the **giver** (article owner) |
| `lx_backlink` reaches `status='verified'` | **1** | At verification time, against the **receiver** (whose URL was linked) |

That's it. No DR weighting, no daily caps, no priority tiers.

### 16.2 Why this is the right model for v1

- **Self-balancing economy.** Every article carries 3 outbound links by default. Each published article costs the giver 1 credit. If all 3 outbound links verify, the giver "pays" 1 + the three receivers each pay 1 — total 4 credits leave the giver and 3 enter the network as the giver's earned-from-network. Net effect: a participating site that publishes diligently and receives reasonably stays roughly credit-neutral; freeloaders (publish but don't enable receiving) burn down. Hoarders (receive but don't publish) also burn down on the receive side. This shapes behavior toward active participation without us tuning anything.
- **Aligned with outrank's UI mental model.** "1 credit = 1 backlink" reads cleanly; outrank's "1 credit = 1 DR" needed multiple FAQ screens to explain.
- **Same code path as crawlproof's existing credit system.** `consume_credit(p_owner uuid, p_count int)` already exists (migration `0007_engine.sql` — used for audit engines). We extend it with a `reason` parameter and reuse.

### 16.3 Credit reasons (extending crawlproof's existing ledger)

```
'lx_publish_article'      -- giver pays 1 when article publishes
'lx_receive_backlink'     -- receiver pays 1 when backlink verifies
'lx_grant_signup'         -- 10 free credits on enabling the exchange
'lx_grant_referral'       -- 10 credits when a referred site activates
'lx_refund_link_removed'  -- +1 refund if backlink later removed (within 30d)
'lx_skip_no_balance'      -- 0 charge; row records that we skipped a publish/receive due to no credits
```

### 16.4 Insufficient credit handling

- **Article publish**: if giver has 0 credits, the `lx.article.generate` job runs but stops before `lx.webhook.deliver`. Article is stored as `status='ready'` with a UI banner "Out of credits — top up to publish queued articles". Backlinks already chosen for this article are deferred. **We do not give the customer free articles.**
- **Backlink receive**: if receiver has 0 credits at verification time, the backlink is allowed to stay (we already inserted the URL into the giver's article and can't retract it) BUT no further backlinks will be created with that receiver as a target until they top up. Set `lx_site.backlinks_enabled = false` automatically; UI shows "Backlinks paused: insufficient credits".

### 16.5 Free credit grant on activation

- 10 credits on enabling the exchange.
- 10 credits per referred site that activates (first signups will all be from the existing crawlproof userbase, so referrals will fly).
- Daily allowance: **none** in v1. Outrank's `dailyLimit: 150` is a safety rail more than a feature — we don't need it until abuse appears.

### 16.6 Topping up

Reuse the existing `app/api/credits/` purchase flow (Stripe + `credit_purchase_receipt` migration is already in place from 2026-05-13). Suggested pack sizes:

| Pack | Credits | Price | $/credit |
|---|---|---|---|
| Starter | 30 | $9 | $0.30 |
| Growth | 100 | $25 | $0.25 |
| Pro | 500 | $99 | $0.20 |

At Pro tier, a customer publishing 1 article/weekday (~22/mo) with 3 backlinks each, fully verified, would consume 22 + 22×3 ÷ 2 average ≈ ~55 credits/month (giver pays publish, receiver pays receive, network averages out across participants). Pro pack covers ~9 months at that pace, leaving healthy margin over our ~$0.60/mo COGS (see §15.6).

---

## 17. Candidate discovery — using crawlproof's existing audit data

> The user's question: "use our internal reports and data we've gathered to find the best sites for link exchanges."

This is the single biggest unfair advantage we have over outrank. Outrank started from zero with no graph; **we already have a `public.audits` table with `target_url`, `score`, `summary jsonb`, `report_markdown` for every site we've ever scanned.** That table is the seed candidate pool.

### 17.1 Migration: promote audits into exchange candidates

```sql
-- Materialized view: every distinct domain we've audited, with our score and topic signals
create materialized view lx_audit_candidates as
select
  lower(regexp_replace(target_url, '^https?://(www\.)?([^/]+).*$', '\2')) as domain,
  max(a.score) filter (where a.score is not null) as best_score,
  count(*) as audit_count,
  max(a.completed_at) as last_audited_at,
  (array_agg(a.id order by a.completed_at desc nulls last))[1] as latest_audit_id,
  (array_agg(a.summary order by a.completed_at desc nulls last))[1] as latest_summary,
  (array_agg(a.report_markdown order by a.completed_at desc nulls last))[1] as latest_report_md,
  bool_or(coalesce((a.summary->>'has_blog')::boolean, false)) as has_blog_signal
from public.audits a
where a.status = 'completed'
  and a.target_url is not null
group by 1;

create unique index on lx_audit_candidates(domain);
create index on lx_audit_candidates(best_score desc);

-- Refresh nightly via existing cron infrastructure (migration 0003_cron.sql / 0012_schedule_daily.sql)
```

### 17.2 Best-site ranking

When matching backlink-exchange targets for a new article on keyword `K` and site `S`, we union three pools and rank:

```
pool_1 = enrolled lx_sites with backlinks_enabled and topical match (cosine sim on embedding)
pool_2 = lx_audit_candidates where:
           - domain not already in lx_site
           - best_score >= 60 (top half of audit scores)
           - has_blog_signal = true
           - last_audited_at > now() - interval '180 days'
pool_3 = manual seed list (crawlproof's own properties, friendly sites)
```

`pool_1` rows are eligible link **targets right now**. `pool_2` rows are **invite candidates** — sites we don't yet have in the network but that look perfect: we email the owner of the audit a magic-link invite ("you audited {domain} on crawlproof; we found 3 sites that want to link to you — claim free traffic"). This is the cold-start fix.

### 17.3 Topic extraction from existing reports

`audits.summary` is jsonb — we don't know its full shape yet, but `audits.report_markdown` is rich free-text. Pipeline:

1. Nightly job extracts topic signals from `latest_report_md` using Claude Haiku 4.5 (cheap):

```
"From the following SEO audit report, output JSON: { niche, target_audiences[], primary_topics[], blog_url_if_detected, language }"
```

2. Store in `lx_audit_candidates_enriched` keyed by domain.
3. Embed `(niche || target_audiences || primary_topics)` into pgvector for matching.

Cost: ~$0.0005 per audit with Haiku. For 10K audited domains: $5 one-time + trivially small for new audits going forward.

### 17.4 Invitation flow

When `pool_2` produces a candidate the matcher wants to use:

1. If we have a known `owner_id` on any audit row for that domain → in-app notification: "3 sites want to link to {domain}. Enable Link Exchange to claim them."
2. Otherwise we have no contact for that domain (the audit was run anonymously). Two options:
   - **Skip and let pool_1 fill the slot.** Cleanest. Default.
   - **Email the abuse@/info@ inbox.** Risky on cold contact, skip in v1.
3. Once they enable → migrate the `lx_audit_candidates` row's topic data into a real `lx_site` (pre-populated from audit data so onboarding is one click).

### 17.5 Quality gate on incoming sites

Every new `lx_site` runs a fresh crawlproof audit on enrollment (free, reuses existing `engine='rule'` cheap path). If the audit reveals:
- Score < 40 → reject from exchange (`status='flagged'`).
- Adult / gambling / illegal-substance content → reject.
- No blog detected → allow as link target only, not as giver.

This keeps the network clean and is something outrank visibly skipped — their network includes plenty of low-quality content. Crawlproof leans into the audit credibility we already sell.

---

## 18. Appendix — captured evidence

Raw artifacts on the workstation under `/tmp/outrank-recon/`:
- `shot-c02-integrations.png` — webhook integration row
- `shot-c03-linking.png` — internal-linking config (sitemap source, page list, prioritize-upgrade lock)
- `shot-c04-backlinks.png` — exchange dashboard with credits/performance
- `shot-c05-art-settings.png` — full article-generation preferences
- `shot-c06-gen-settings.png` — site/business profile
- `shot-c01-scheduler.png` — content planner calendar
- `network_click.ndjson` — every XHR request/response captured during the crawl
- `text-*.txt` — innerText of each authenticated route

Captured product row (with all fields used by the algorithm) and a verified backlink row are quoted in §1.3 and §1.7 respectively.
