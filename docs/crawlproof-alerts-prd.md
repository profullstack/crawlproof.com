# CrawlProof Alerts — PRD (v1.1, implemented)

**Status:** Phase 1 built · **Date:** July 4, 2026 · **Product:** crawlproof.com

> v1.1 revises the original draft with six pre-launch fixes surfaced in
> critique (economics, cold-start, canonical dedupe, email batching, backlink
> framing, trust & safety) and records what shipped. Changes from v1.0 are
> called out inline as **[v1.1]**.

---

## 1. Problem Statement

Founders, marketers, SEOs, and sales teams need to know the moment something new
appears on the web about their brand, keywords, or competitors. Google Alerts is
slow and incomplete; enterprise tools (Mention, Brandwatch, Ahrefs Alerts) cost
$50–$300+/mo; F5Bot only covers Reddit and Hacker News.

CrawlProof already owns the "see your site the way crawlers do" positioning plus
crawling infrastructure and a credit-based billing model. Alerts extends that
from a one-time audit into a recurring-engagement product.

## 2. Solution Overview

Free, near-realtime email alerts for anything findable through Google search,
powered by the ValueSERP API, with CrawlProof's crawler used to verify results
where SERP data alone is insufficient (confirming a backlink exists in a page's
HTML).

**Core loop:** email + category → magic-link confirm → scheduled ValueSERP poll,
recency-filtered → dedupe every result URL against what the user has already been
shown → only never-seen URLs email → backlink candidates crawled and HTML-checked
before alerting → emails link back to manage/upgrade.

## 3. Goals

- **Recurring engagement** — 40% of signups still have ≥1 active alert at day 30.
- **Top-of-funnel growth** — alerts = 25% of new email captures within 90 days.
- **Paid conversion** — 3% free→paid among users who hit a limit.
- **Cost discipline** — blended SERP + email cost per free user < $0.15/mo.

## 4. Non-Goals (v1)

- Monitoring existing backlinks for loss/nofollow changes (discovery-only in v1).
- Non-Google sources polled directly (Reddit/Discord/app stores) — all via SERPs.
- In-app/webhook/Slack channels — email only.
- Sentiment analysis / AI summarization.
- Team/multi-seat accounts — one email per account.

## 5. Target Users

Primary: (a) founders/indie hackers, (b) marketers/SEOs, (c) sales reps. Secondary:
vanity/name monitoring (high-volume top-of-funnel).

## 6. Starter Alert Categories

Sixteen templates compile the user's single input down to a ValueSERP query with a
recency filter (see `lib/alerts/categories.ts`). **[v1.1]** People-tracking
templates (Your name, Reputation risk, Impersonation, Legal) are flagged `gated`
and **withheld from the launch picker** pending a trust-and-safety / GDPR policy —
they exist in code but are filtered out of both signup and dashboard pickers.

| Category | Underlying query pattern | Launch set | Gated |
|---|---|:--:|:--:|
| Brand mentions | `"brand"` | ✅ | |
| Your name | `"first last"` | | 🔒 |
| Competitor watch | `"competitor" (launches OR announces OR review)` | ✅ | |
| New backlinks | `"domain.com" -site:domain.com` + crawl confirm | ✅ | |
| Buying intent | `"best X for" OR "alternative to Y"` | ✅ | |
| Community questions | `kw site:reddit.com OR quora OR stackoverflow` | | |
| Reputation risk | `"brand" (scam OR complaint OR problem)` | | 🔒 |
| Impersonation & security | `"brand" (fake OR phishing OR breach OR leaked)` | | 🔒 |
| Guest post spots | `"write for us" niche` | | |
| Press coverage | `kw (site:prnewswire.com OR businesswire.com)` | | |
| Jobs & hiring | `"title" site:linkedin.com/jobs OR indeed.com` | | |
| Deals & restocks | `"product" (deal OR sale OR "in stock")` | | |
| Legal & regulatory | `"company" (lawsuit OR fined OR investigation)` | | 🔒 |
| Events & launches | `kw (conference OR summit OR launches) 2026` | | |
| New research | `kw site:arxiv.org OR pubmed` | | |
| Custom query | Free-text, validated before save | | |

Recommended onboarding default: prompt for domain, pre-suggest the five launch-set
alerts (brand, name†, one competitor, one buying-intent, new backlinks). †Name is
gated in v1, so the shipped default set drops it until the T&S policy lands.

## 7. Requirements & what shipped

### Must-Have (P0) — all implemented

- **Email-only signup (double opt-in).** `requestAlertSignup` sends a Supabase
  magic link (`signInWithOtp`); the pending alert rides in the redirect and is
  created only after confirmation. Unconfirmed emails receive nothing further.
  *(`app/actions/alerts.ts`, `app/(marketing)/get-alerts/`)*
- **Free tier: 50 active alerts, daily checks.** Enforced in `createAlert` /
  `resumeAlert`. **[v1.1]** Backed by a *second* cost axis — see §8.
- **Category templates.** Full picker; users never type an operator.
- **Polling & dedupe engine.** ValueSERP with per-alert recency; dedupe on
  canonical/normalized URL (`lib/alerts/dedupe.ts` — http/https and www/non-www
  collapse, tracking params/fragments/trailing slashes stripped, params sorted).
  *(`lib/alerts/engine.ts`, `valueserp.ts`)*
- **Alert emails.** One digest, new results only, per-alert pause + global
  unsubscribe links. Zero new results → nothing sent. *(`lib/alerts/email.ts`)*
- **Backlink discovery.** SERP candidate → `fetchPage` → HTML anchor check →
  JS-rendered fallback → alert only on a confirmed anchor; fetch failures retry
  once before drop, never falsely reported. *(`lib/alerts/backlink.ts`)*
- **Management dashboard.** List / create / pause / resume / delete, remaining
  slots, monthly check budget, last-checked time. *(`app/(app)/alerts/`)*
- **Paid upgrade path.** Plan-gated caps + hourly frequency; billed through the
  existing credit/plan system (`profiles.plan`). *(`lib/alerts/limits.ts`)*
- **Abuse & cost controls.** Disposable-email block, query length/illegal-content
  validation, Supabase-Auth per-IP/email OTP rate-limiting, per-account SERP
  budget, and a global kill-switch (`cron_config.alerts_enabled`).
  *(`lib/alerts/validate.ts`, `app/api/cron/alert-checks/route.ts`)*

### Nice-to-Have (P1)

- **[v1.1] Instant test run — promoted to P0 and shipped.** "See current results"
  in the create form (`testRunAlert`). It is both the activation lever *and* the
  mechanism that makes the cold-start baseline (§10) invisible to users.
- Cross-sell into audits (backlink/brand emails → "Run an AEO audit") — *pending.*
- Digest frequency choice for paid users — hourly shipped; "instant" pending.
- Public "recent finds" page — pending.

### Future (P2)

AI-answer monitoring (result schema already URL-agnostic-friendly), lost-backlink
monitoring (crawler reuse), webhook/Slack delivery.

## 8. Free Tier & Monetization — **[v1.1] corrected economics**

| | Free | Paid (pro / team) |
|---|---|---|
| Signup | Email only (magic link) | Same account + billing |
| Active alerts | 50 | 250 / 1,000 |
| Check frequency | Daily | Hourly |
| **Monthly SERP-call budget** | **400** | 200,000 / 1,000,000 |
| Backlink discovery | Included | Included, hourly |

**Why a call budget, not just an alert count.** The original "50 free daily
alerts" implies up to 1,500 ValueSERP calls/user/month ≈ **$1.50–$3.00** — 10–20×
the $0.15/free-user ceiling, and F5Bot's "free that works" economics don't
transfer because F5Bot rides *free* Reddit/HN APIs while ValueSERP bills per
search. The blended average stays low only because most users run a handful of
alerts. So the real cost backstop is a **per-account monthly SERP-call budget**
(`consume_alert_serp_budget` RPC, atomic, lazy 30-day reset): a maxed-out or abuse
account is bounded to well under a dollar, while typical users never touch it.
Test runs debit the same budget so they can't be used as a free search proxy.

Paid pricing must clear SERP COGS: 250 alerts checked hourly ≈ 180k calls/mo ≈
$108–$180 COGS, so the pro tier is priced above that (pricing sign-off still open,
§11) and cannot undercut incumbents on the heavy hourly plans — the disruption
story lives at the free tier.

## 9. Success Metrics

Leading (30d): ≥60% create ≥2 alerts first session; median first-value ≤48h;
open ≥40%, spam <0.1%, pause <5%/mo. Lagging (90d): 40% D30 retention; 3%
cap-hitter conversion; cross-product audit lift; blended unit cost ≤ $0.15/mo.

## 10. Technical Considerations & decisions

- **Architecture.** Reuses the app's `pg_cron → /api/cron/<job> → worker`
  pattern. `crawlproof-alert-checks` fires every 10 min; the endpoint honors each
  alert's `next_run_at` (daily vs hourly), groups due alerts **by owner**, and
  hands each owner to the worker as one job.
- **[v1.1] Cold-start baseline.** An alert's *first* poll only seeds the dedupe
  set (`alerts.seeded`) — no email, no crawl. Immediate value comes from the
  instant test run, not a blast of pre-existing SERP results.
- **[v1.1] One digest per user, not per alert.** The worker batches every pending
  finding across all of a user's alerts into a single email (`emailed_at IS NULL`
  → send → stamp). 50 alerts × daily would otherwise be up to 50 emails/day/user.
- **[v1.1] Canonical dedupe is normalized-URL, not true canonical.** SERP gives a
  URL, not the page's `<link rel=canonical>`; confirming a real canonical would
  mean crawling every result. Cross-domain syndication may therefore duplicate —
  an accepted v1 limitation, documented rather than silently promised.
- **[v1.1] Backlink category framing.** It surfaces *newly-indexed pages that
  mention and link the domain* — a real subset, gated by Google's index lag and
  by the page containing the domain string. Not a full backlink crawler.
- **Crawler reuse.** Backlink confirm uses the existing `fetchPage` + JS-rendered
  `attachRendered` fallback (JS-injected links are common).
- **Email deliverability.** Alerts ride a dedicated sender (`ALERTS_FROM`,
  default `alerts@alerts.crawlproof.com`) separate from transactional audit mail,
  with `List-Unsubscribe` / one-click headers. **Start subdomain warm-up before
  Phase 1 traffic.**
- **Noise control.** Results capped at 10/check (one SERP call, top by position);
  backlink crawls capped per check.

## 11. Open Questions

| Question | Owner | Blocking |
|---|---|:--:|
| Free-cap definition — **resolved [v1.1]**: 50 active alerts **and** a 400-call/mo budget. | Product | closed |
| Paid pricing must clear hourly SERP COGS (~$108–$180/mo at 250 alerts). | Product | **yes** |
| ValueSERP plan/rate limits at projected volume. | Eng | **yes** |
| Most reliable recency filter per category (empirical). | Eng | no |
| GDPR + T&S review before un-gating people-tracking templates. | Legal | **before un-gate** |
| "Powered by CrawlProof" growth footer + referral link. | Marketing | no |

## 12. Phasing

- **Phase 1 (this build):** P0 scope + instant test run + five launch-set
  categories (name gated) + custom query. Watch cost and deliverability.
- **Phase 2:** un-gate people-tracking after T&S/GDPR; audit cross-sell links;
  public recent-finds page; pricing finalized.
- **Phase 3:** AI-answer monitoring; webhook delivery; lost-backlink monitoring.

---

## Implementation status (v1.1)

**Migration:** `supabase/migrations/20260704120000_alerts.sql` — `alerts`,
`alert_seen_urls`, `alert_findings`; `profiles.alert_serp_calls_*`;
`consume_alert_serp_budget` RPC; `crawlproof-alert-checks` pg_cron job.

**Engine & libs (`lib/alerts/`):** `categories.ts` (16 templates, gating,
launch set), `valueserp.ts` (client, recency, retry, billable-call count),
`dedupe.ts` (canonical/normalized URL + domain matching), `backlink.ts`
(anchor confirm + JS fallback), `engine.ts` (poll → dedupe → cold-start seed →
confirm → persist findings; `previewAlert`), `email.ts` (batched digest),
`tokens.ts` (signed pause/unsubscribe), `limits.ts` (caps + budgets),
`validate.ts`, `worker.ts` (per-user processing + digest send).

**Routes & UI:** `app/api/cron/alert-checks/route.ts`;
`app/api/alerts/{pause,unsubscribe}/route.ts`; `app/actions/alerts.ts`;
`app/(app)/alerts/` (dashboard + create/actions clients); nav link;
`app/(marketing)/get-alerts/` (public signup); worker HTTP route
`/alerts/check-user` in `worker/index.ts`.

**Tests:** `tests/alerts/{dedupe,categories,validate}.test.ts` (26 cases) —
canonical dedupe, template compilation, backlink anchor detection, abuse
validation. App + worker `tsc --noEmit` clean.

**Config to set at deploy:** `VALUESERP_API_KEY`, `ALERTS_FROM` (warmed
subdomain), optional `VALUESERP_LOCATION` / `ALERT_DISPOSABLE_EXTRA`; seed
`cron_config` (`site_url`, `cron_secret`), and `alerts_enabled=false` is the
global kill-switch.

**Deliberately deferred:** audit cross-sell links, public recent-finds page,
"instant" delivery tier, un-gating people-tracking templates (needs Legal/T&S),
and all P2 items.
