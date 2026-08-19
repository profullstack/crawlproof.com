# CrawlProof Promote — Multi-Channel Promotion Engine

**Status:** architecture baseline. Phase 1 content sources are built; the rest is design.
**Last reconciled with `master`:** 2026-08-19, at `a1a7d30` (PR #206).
**Primary interface:** `/dashboard/promote`
**Surfaces:** PWA/Web, CLI, HTTP API, MCP
**First provider:** Reddit

This document is the target architecture for Promote. `promote-prd.md` describes the
drip engine that shipped in July 2026 and is still accurate about that engine; this
one describes what Promote becomes. Where they disagree, this document wins.

---

## 0. Runtime baseline — read this before building anything here

The architecture brief this document is derived from specified *"Bun services on
Railway, Turso for control-plane data, Redis/BullMQ-compatible durable queues and
distributed rate limiting."* **That is not the stack CrawlProof runs on**, and building
to it would fork the product.

What is actually true:

| Concern | Brief said | CrawlProof actually uses |
|---|---|---|
| App runtime | Bun services | **Next.js 16** on Node, one app (`app/`) |
| Control-plane data | Turso | **Supabase Postgres** (`ywcizjsgrcmhgyplldac`), with RLS |
| Background work | Separate Bun services | **One worker** (`worker/index.ts`) of `setInterval` sweeps on Railway |
| Queues | Redis/BullMQ everywhere | BullMQ exists but is used **only** for the port-scan prober; every other sweep claims rows in Postgres |
| Rate limiting | Distributed limiter | Per-sweep throttles in Postgres (`lib/sp/feedAutopost.ts` `POST_THROTTLE_MS`) |

The service boundaries in §11 of the brief (`promote-api`, `feed-ingestor`,
`content-selector`, `promote-scheduler`, `provider-workers`, `metrics-worker`) are
**module boundaries here, not deployments**. They map onto `lib/promote/*` and sweeps
in the single worker. Keep the seams — they are good seams, and they are what would
make a later split cheap — but do not stand up six services for a feature whose whole
job is to post a few links an hour.

The claim-a-row-then-work pattern the existing sweeps use (`next_run_at` pushed
forward before processing) is the house substitute for a queue lease, and it is what
the new ingestion sweep uses too.

---

## 1. Product definition

Promote is a multi-channel publishing and content-discovery engine. A user connects
one or more social accounts, configures one or more content sources, and creates
campaigns that publish relevant content through selected connected accounts.

The Reddit integration is the first provider, not a standalone subsystem. Every
surface — PWA/Web, CLI, API, MCP — calls the same service layer and uses the same
campaign, authorization, scheduling, dedupe and audit model.

A campaign may publish the user's own content, content from custom RSS/Atom feeds,
shared topical content from RSS Amplifier, a configurable blend of owned and shared,
manually submitted URLs, and later CrawlProof-generated content such as Autoblog items.

---

## 2. What exists today

### 2.1 Built before this document

The drip engine (`promote-prd.md`), shipped July 2026:

- `promo_list` — a campaign: cadence, post mode, target accounts, brand voice.
- `promo_link` — the rotation unit. Hand-pasted URLs.
- `promo_post` — one publication attempt, with credits and error history.
- `lib/promote/sweep.ts` — the 60s sweep: claim due lists, pick a link, write a
  fresh pitch, publish, debit a credit.
- `lib/promote/generatePitch.ts` — dual-provider (Anthropic + OpenAI) copywriter
  with per-platform voice profiles and anti-repeat.
- Connected accounts reuse `sp_account`, and publishing reuses `lib/sp/post.ts` and
  `lib/sp/platforms/*` (bluesky, discord, facebook, linkedin, mastodon, reddit,
  telegram, threads, x, plus a Playwright browser path).

### 2.2 Built by this change — content sources

Campaigns can now feed themselves. Migration
`supabase/migrations/20260818190000_promote_sources.sql`.

- **`promo_feed`** — the shared fetch registry, keyed on feed URL, with no `user_id`.
  Two hundred users tracking "bitcoin" poll RSS Amplifier **once between them**.
  Carries ETag/Last-Modified, a fetch interval, and geometric failure backoff.
- **`promo_feed_item`** — normalized entries of a feed, also shared, unique on
  `(feed_id, url_hash)`.
- **`promo_source`** — one campaign's subscription to one feed, carrying the
  ownership classification and a per-ingest cap.
- **`promo_link`** gains provenance (`source_id`, `ownership`, `summary`,
  `image_url`, `author_name`, `source_name`, `normalized_url`, `url_hash`,
  `published_at`) and a partial unique index on `(list_id, url_hash)`.
- **`promo_post`** gains `ownership`, `source_id` and `via_fallback`, denormalized
  the way `platform` already is, so the blend can read its own history.
- **`promo_list`** gains `source_mix` and `fallback_policy`.

Modules:

| Module | Job |
|---|---|
| `lib/promote/keywords.ts` | keyword → RSS Amplifier topic slug and feed URL |
| `lib/promote/normalizeUrl.ts` | canonical (publishable) vs identity (dedupe) URL forms |
| `lib/promote/feedParse.ts` | RSS/Atom → normalized items with summary, image, author, `<source>` attribution |
| `lib/promote/ingest.ts` | conditional fetch, store, fan out to subscribers |
| `lib/promote/sources.ts` | validate and register sources |
| `lib/promote/blend.ts` | deficit-based ownership selection (pure) |
| `lib/promote/selectLink.ts` | the database side of selection |

Surfaces: `/dashboard/promote/[id]` gains a **Content sources** and a **Content mix**
section; `app/actions/promote.ts` gains `addKeywordSources`, `addFeedSource`,
`toggleSource`, `removeSource`, `updateBlend`; MCP gains `promote_list_campaigns`,
`promote_add_keyword_source`, `promote_add_feed_source`, `promote_list_sources`.

### 2.3 Not built yet

Reddit destinations and subreddit discovery, approval modes, relevance scoring,
crossposts, per-destination cooldowns, account groups, the HTTP API surface, and the
CLI. §5 onward describes these.

The durable job model *is* built — see §9. It is listed under §16 phase 1 as the
piece the rest of the scheduler hangs off.

---

## 3. Content sources

### 3.1 Types

```ts
type PromoteSourceType =
  | "project_feed"
  | "custom_feed"
  | "rssamplifier_topic"
  | "manual_url"
  | "crawlproof_autoblog";
```

### 3.2 Keyword sources

A keyword becomes exactly one RSS Amplifier topic feed:

```
bitcoin  →  https://rssamplifier.com/topics/bitcoin.rss
```

Several keywords become several independent sources, never one combined URL:

```
bitcoin, blockchain, ethereum
  → /topics/bitcoin.rss
  → /topics/blockchain.rss
  → /topics/ethereum.rss
```

**Slugging matters and is verified against the live directory.** RSS Amplifier serves
`/topics/artificial-intelligence.rss`, *not* `/topics/artificial%20intelligence.rss`,
so keywords are hyphenated, not percent-encoded. An unknown topic returns **404**,
which is what lets a keyword be validated the moment the user adds it rather than
silently producing a campaign that never posts.

Normalization: trim, collapse whitespace, lowercase, strip diacritics and
punctuation, hyphenate, deduplicate by slug, keep a display label. Keyword lists
split on commas and newlines **but never on spaces** — "artificial intelligence" is
one keyword.

### 3.3 Custom feeds

Any RSS or Atom URL. Fetched and parsed before it is saved, so "that address is
reachable but is not a feed" is caught in the form. Bare hostnames are accepted and
assumed `https`. Private and link-local addresses are refused, the same guard
`lib/audit/engine.ts` applies to user-supplied targets.

### 3.4 Ownership

```ts
type ContentOwnership = "owned" | "partner" | "shared";
```

Ownership drives blend ratios, attribution, and fallback. Keyword sources default to
`shared`; a feed the user deliberately added defaults to `owned`; hand-pasted links
are `owned`.

### 3.5 URL identity

Two forms, deliberately kept apart:

- **canonical** — what we publish. Tracking parameters removed; host case, `www.`,
  scheme and trailing slash untouched, so the link resolves as the publisher meant.
- **normalized** — dedupe identity only. Scheme folded to `https`, `www.` dropped,
  trailing slash removed, query sorted. `url_hash` is its sha256.

A bare `ref` parameter is **not** stripped: it is tracking on some sites and routing
on others, and losing an attribution tag is cheaper than publishing a link that 404s.

---

## 4. Campaigns, blend and fallback

A campaign joins content sources to connected accounts and destinations.

### 4.1 Blend

`promo_list.source_mix` weights each ownership class:

```json
{ "owned": 70, "partner": 0, "shared": 30 }
```

**Selection is deficit-based, not weighted-random.** Weighted random gives streaks,
and a streak of shared content is exactly what makes an automated account read as a
content farm. On every tick the class furthest below its target share posts. Over 100
ticks a 70/30 campaign posts exactly 70 owned and 30 shared, and never runs the same
class more than three times consecutively. Within a class the rotation is unchanged:
least-recently-promoted first.

The window is the last 50 posts, long enough to be a ratio and short enough that
changing the mix takes effect within a day.

**The mix is narrowed to the classes the campaign can actually supply** before any
deficit is computed — `effectiveMix()` in `lib/promote/blend.ts`. A class survives the
narrowing if the campaign has a link ready in it *or* an enabled source feeding it;
if nothing survives, the configured mix is used unchanged. So an all-owned campaign
runs on a 100%-owned effective mix and posts on target forever, and shared re-enters
the mix the moment a keyword source is added.

This is not a refinement, it is what keeps the feature alive. The sources migration
backfilled every pre-existing list with the 70/30 default. Without the narrowing, a
campaign holding only owned links reads that as "30% short on shared", finds no
shared inventory, covers with owned content, and marks each post `via_fallback` —
and then the daily fallback cap below stops it posting at all. In production that
mislabelled six posts within minutes of the migration and was three posts from
silencing the campaign (PR #205).

The general rule, which outlives this feature: **a class with no inventory and no
source is not starved, it is not part of that campaign's mix.** Backfilling a policy
default onto rows that predate the policy makes those rows look permanently in
violation of it, and a quota on the violation path turns that into silent death
rather than a visible error.

### 4.2 Fallback

```json
{
  "whenOwnedQueueEmpty": "use_shared",
  "whenSharedQueueEmpty": "use_owned",
  "maxFallbackItemsPerDay": 3
}
```

This is what lets a user with no original content still run a campaign, while the cap
stops it becoming an uncontrolled shared-content firehose. Fallback posts are marked
`via_fallback` and counted over a rolling 24 hours — rolling rather than calendar, so
the cap cannot be gamed at a midnight boundary.

Fallback only applies **within the effective mix of §4.1**. Covering for a class the
campaign never had is not a fallback and must not be marked or capped as one; only a
class that is genuinely in the mix and genuinely ran dry counts against the cap.

---

## 5. Provider adapter contract

All providers implement one interface. The scheduler must never contain
provider-specific posting logic; it creates jobs and invokes the selected adapter.

```ts
interface PromoteProviderAdapter {
  provider: string;

  getAuthorizationUrl(input: AuthorizationInput): Promise<string>;
  exchangeAuthorizationCode(input: AuthorizationCodeInput): Promise<TokenSet>;
  refreshAccessToken(connection: PromoteConnection): Promise<TokenSet>;

  listAccounts(connection: PromoteConnection): Promise<ProviderAccount[]>;
  discoverDestinations(input: DestinationDiscoveryInput): Promise<DestinationCandidate[]>;
  inspectDestination(input: DestinationInspectionInput): Promise<DestinationProfile>;

  preflight(input: PromotePreflightInput): Promise<PromotePreflightResult>;
  publish(input: PromotePublishInput): Promise<PromotePublishResult>;

  reshare?(input: PromoteReshareInput): Promise<PromotePublishResult>;
  deletePublication?(input: DeletePublicationInput): Promise<void>;
  readMetrics?(input: ReadMetricsInput): Promise<PromoteMetrics>;

  getRateLimitState(connection: PromoteConnection): Promise<RateLimitState>;
}
```

`lib/sp/platforms/*` is the existing informal version of this. Formalizing it is a
refactor of what is already there, not a rewrite — the publish path in
`lib/sp/post.ts` already dispatches per platform.

---

## 6. Reddit provider

The adapter supports OAuth with refresh, keyword-based subreddit discovery, filtering
by recent activity / link-submission support / crosspost support, rule and
post-requirement preflight, original link submissions, one primary subreddit plus
zero to two delayed crossposts, required flair, per-destination copy templates,
duplicate and cooldown checks, and publication URL capture.

```ts
interface RedditPromoteDestination {
  provider: "reddit";
  connectionId: string;
  subreddit: string;

  enabled: boolean;
  approvedByUser: boolean;

  rulesReviewedAt: string | null;
  rulesHash: string | null;

  allowOriginalLinks: boolean;
  allowCrossposts: boolean;

  flairTemplateId: string | null;

  minDestinationGapHours: number;
  minDomainGapHours: number;

  crosspostRole: "primary" | "secondary" | "either";
}
```

Publication pattern: primary subreddit → original link submission → delay → secondary
subreddit 1 → delay → secondary subreddit 2. Every secondary publication must be
destination-approved, rules-reviewed, relevant, and individually preflighted **at
execution time**, not at scheduling time.

Existing groundwork: `lib/sp/platforms/reddit.ts`, `lib/sp/platforms/redditOutreach.ts`,
`lib/sp/redditSubreddit.ts`, and OAuth at `app/api/sp/oauth/reddit/*`.

---

## 7. Relevance and selection

Before an item reaches the queue, score it against the campaign and destination.

```ts
interface PromoteRelevanceScore {
  total: number;
  keywordScore: number;
  destinationScore: number;
  freshnessScore: number;
  sourceQualityScore: number;
  ownershipPriorityScore: number;
  duplicationPenalty: number;
}
```

Sequence: reject expired or malformed → canonicalize → drop already-published
duplicates → apply blocked/competitor-domain rules → match campaign keywords → match
destination context → freshness → source quality → **blend selection (built)** →
generate copy → provider preflight → schedule or send to review.

---

## 8. Deduplication

Levels: global canonical URL, per account, per connected provider account, per
destination, per campaign, same-story similarity across different URLs, domain
cooldown, destination cooldown.

Built today: per-campaign dedupe via the partial unique index on
`promo_link (list_id, url_hash)`, and per-feed dedupe via
`promo_feed_item (feed_id, url_hash)`. `normalizedTitleHash` exists for same-story
detection but is not yet stored.

The eventual publication key:

```sql
UNIQUE (campaign_id, connection_id, destination_key, normalized_url)
```

---

## 9. Scheduling and jobs

**Built.** `promo_job` (migration `20260819120000_promote_jobs.sql`) and
`lib/promote/jobs.ts`. A job is one intended publication: one link, to one account,
at one destination, for one scheduling slot. It carries the resolved URL and title
frozen at plan time, the body once a worker has written it, the ownership and source
that selected it, an attempt count, a state, and an idempotency key.

The state machine is `queued → preflighting → blocked → publishing → published |
retrying | failed | cancelled`. Only `queued`, `publishing`, `published`, `failed`
and `cancelled` are reached today; the other three are in the CHECK constraint
already so the Reddit provider does not need a migration to use them.

### 9.1 Why the old claim did not hold

The sweep read every due campaign and "claimed" each by pushing `next_run_at`
forward. That UPDATE carried no predicate on `next_run_at`, so it was a
read-then-write: two sweeps that both read the row both won it. And the worker runs
the sweep on a 60s interval *and* out-of-band for "Post now"
(`POST /dashboard/promote/sweep`), so overlapping runs are designed in, not rare.

Downstream, nothing was idempotent. A crash between `postViaAccount()` returning and
the `promo_post` insert left no record; `last_promoted_at` is only stamped at the end
of the campaign, so the same link was still least-recently-promoted on the next tick
and went out again.

### 9.2 The two mechanisms

**Plan before publishing.** Jobs are inserted before anything is sent, keyed on
`sha256(list, link, account, destination, kind, slot)`. The slot is the `next_run_at`
value the sweep *observed as due* — not the wall clock, which would give each sweep
its own key and rebuild the bug. A racing sweep derives the same keys, loses to the
unique index, and gets nothing back, so it publishes nothing.

**Claim by compare-and-swap.** `update ... where id = ? and state = 'queued'`. The
read and the write are one statement, so two workers cannot both observe `queued`.
Postgres decides ownership; a prior SELECT does not.

The campaign-level claim is still there and now carries a predicate — it re-asserts
the same "still due" condition the select used (`.lte("next_run_at", dueBy)`), so the
loser's update matches nothing once the winner has pushed the campaign forward. It
re-asserts the condition rather than matching the exact timestamp read back, because
a predicate that silently never matched would stop every campaign posting with
nothing in the logs. It is an optimization either way — it saves duplicated work. The
guarantee lives in the job.

### 9.3 At most once, deliberately

A job still `publishing` past its lease (`PUBLISH_LEASE_MS`, 10 minutes) is **failed,
never retried**. No provider we publish through accepts an idempotency key, so an
interrupted publish has genuinely unknown outcome — the post may be live. Re-running
it is the duplicate this exists to prevent. The reaper closes it with the outcome
recorded as unknown and surfaces it in history for a human. The credit is not
refunded, because refunding a post that was in fact delivered is the other way to be
wrong; support can refund from history.

Retry is therefore reserved for failures that provably happened *before* the publish
call. Bounded retry with backoff for those is still open, and is what `retrying` and
`attempt_count` are for.

A pending cookie-auth post counts as published for the job: it has been handed to the
Playwright worker, so the job must not run again. `reconcilePromo` settles the
`promo_post` later, as before.

Schedule model — interval / times-of-day / cron, timezone, days of week, quiet hours,
jitter, and per-day caps overall and per provider — is still the existing single
`cadence_seconds` plus quiet hours. Not built.

---

## 10. Ingestion and fan-out

```
normalized keyword: bitcoin
        ↓
one promo_feed row (shared, no user_id)
        ↓
one scheduled fetch, conditional on ETag/Last-Modified
        ↓
promo_feed_item rows, normalized and fingerprinted
        ↓
fan out into promo_link for every subscribing campaign
```

Rules, all of which the built ingestion follows: fetch each normalized shared feed
once per interval; cache conditional request metadata; cap items per source per pass;
back off geometrically on failure and surface the error on the source; never let one
bad feed take down a sweep.

Rules still to come: partition provider queues by provider and connection; rate-limit
by provider client, connected account and endpoint; idempotency keys on every
publication; bounded retries with jitter; dead-letter permanent failures. Never log
raw OAuth tokens (already true — tokens live in the `sp_account` vault).

---

## 11. Surfaces

`/dashboard/promote` should carry overview (active campaigns, queue depth, posts
today, failed/blocked jobs, account health, engagement, source freshness warnings),
campaigns, sources, connected accounts, destinations, queue and history.

Built: campaigns, sources (add keywords / add a feed / pause / remove / health and
import counts), content mix, links with provenance, recent posts.

Not built: queue preview and approval, destination management, history filtering by
destination, engagement metrics.

### HTTP API (not built)

```
POST   /api/v1/promote/sources
GET    /api/v1/promote/sources
GET    /api/v1/promote/sources/:sourceId/items
PATCH  /api/v1/promote/sources/:sourceId
DELETE /api/v1/promote/sources/:sourceId
...
```

Adding several keywords returns **one source per normalized keyword**:

```json
{ "type": "rssamplifier_topic", "keywords": ["bitcoin", "blockchain"], "ownership": "shared" }
```

### CLI (not built)

`cli/index.ts` currently has no promote commands. Target surface per the brief:
`crawlproof promote source add --keywords bitcoin,blockchain`, `campaign create
--mix owned=70,shared=30`, `queue approve`, `history`, all with
`--format table|json|jsonl`.

### MCP (partly built)

Built: `promote_list_campaigns`, `promote_add_keyword_source`,
`promote_add_feed_source`, `promote_list_sources`, alongside the existing
`list_accounts`, `generate_promo_post`, `post_to_socials`, `promote_url`.

Any MCP publication tool must require an explicit connected account and destination,
and its response should include the preflight summary and idempotency key.

---

## 12. Copy generation

```ts
interface PromoteCopyPolicy {
  mode: "feed_title" | "template" | "ai_rewrite";
  template: string | null;
  includeSummary: boolean;
  includeSourceName: boolean;
  includeHashtags: boolean;
  maxHashtags: number;
  preserveOriginalTitle: boolean;
  prohibitedPhrases: string[];
}
```

Not built as a policy object, but the substance of the attribution requirement is:
`generatePitch` now takes `ownership`, `summary` and `sourceName`, and shared content
gets an explicit instruction never to imply we wrote it and to credit the source by
name. Without that the model happily announces somebody else's blog post as though
the account shipped it.

---

## 13. Review and automation modes (not built)

`manual`, `review_first`, `automatic`. Recommended defaults: new connected accounts
and newly discovered destinations start at `review_first`; shared-content-only
campaigns start at `review_first`; `automatic` unlocks after a campaign has valid
destinations, healthy sources and successful reviewed publications.

---

## 14. Policy and abuse controls

Promote provides publishing automation, not indiscriminate mass posting.

Required: explicit authorization per connected account; explicit destination
selection; per-account and per-destination limits; domain and destination cooldowns;
duplicate prevention; destination-rule preflight; **no** automated voting, liking,
following, joining or account creation; **no** proxy rotation to evade limits; **no**
hidden account fan-out; clear provenance for shared content; pause campaigns after
repeated provider rejections; allow providers and administrators to disable abusive
campaigns; retain an auditable record of requesting user and exact publication.

Of these, provenance for shared content and duplicate prevention are built. The
`maxFallbackItemsPerDay` cap is a mass-posting control as much as an editorial one.

"Pause after repeated provider rejections" is now half-built, at the connected-account
layer rather than the campaign layer: `lib/sp/accountHealth.ts` (PR #206) stops
retrying an account whose consecutive failures have run away — the case that prompted
it had logged 2,953. Campaign-level pausing on destination rejection is still open, and
the Reddit provider will need it, since a subreddit rejection is a destination fact
rather than an account one.

---

## 15. Acceptance criteria

| # | Criterion | State |
|---|---|---|
| 1 | One keyword creates one RSS Amplifier topic source | **built** |
| 2 | Comma-separated keywords create deduplicated sources | **built** |
| 3 | Multiple custom RSS/Atom feeds can be added | **built** |
| 4 | A campaign can contain owned and shared source groups | **built** |
| 5 | A campaign maintains a configured owned/shared ratio | **built** |
| 6 | Shared content acts as fallback when the owned queue is empty | **built** |
| 7 | One or more authorized connected accounts can be selected | built (pre-existing) |
| 8 | Web, CLI, API and MCP use the same campaign and job records | partial — web + MCP; no CLI or API |
| 9 | A shared topic feed is fetched once and reused across campaigns | **built** |
| 10 | No publication runs without an idempotency key | **built** |
| 11 | Reddit checks activity, links, crossposts, rules, requirements | not built |
| 12 | Reddit supports one original link and up to two delayed crossposts | not built |
| 13 | Every attempted publication appears in history and audit log | built (pre-existing) |
| 14 | A failed worker cannot double-publish after retry or failover | **built** — per publication |
| 15 | Preview and approve the exact item, copy, account and destination | not built |

---

## 16. Delivery phases

1. **Shared Promote core** — source normalization, keyword and custom-feed ingestion,
   campaigns and blending, connected accounts, dashboard. *Sources, blending,
   ingestion and the durable job model are built. The richer schedule model
   (times-of-day, cron, per-provider caps) and the review queue are not.*
2. **Reddit provider** — server-side OAuth, subreddit discovery, activity/link/
   crosspost filtering, rules and requirements, original link posting, delayed
   crossposts, Reddit-specific preflight and metrics.
3. **MCP** — read tools, campaign preview, explicit schedule and publish tools,
   audit-log integration. *Source tools built.*
4. **Additional providers** — added through the adapter contract without modifying
   campaign or source architecture.
