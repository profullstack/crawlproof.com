# Crawlproof Lead Engine — PRD

> Goal: turn the **free scan we already run** into a lead-generation loop. Today an anonymous visitor types a URL into the hero form, gets a full report, and leaves — we keep a row in `audits` and, if they wanted a PDF, an email. Nothing about that flow is designed to *propagate* or to *come back*.
>
> This PRD adds four milestones, ordered by leverage-per-day-of-work, that reuse infrastructure that already exists: the free no-LLM **Slop Score** engine, share tokens (`lib/shareToken.ts` → `/r/[token]`), the two public embeddable scripts (`/stats.js`, `/ad.js`), the referral store (`lib/referrals.ts`), the Prospects org + `/recent` outreach surface, and the alerts/cron spine.
>
> **Non-goal, deliberately:** identifying *people*. The Audience Hub (visitor identify / contact graph / reverse lookup) was removed 2026-06-18 as an info-handling risk, and nothing here reopens it. Every lead in this PRD is someone who **typed their own URL into a box** or **asked to be emailed**. That is a volunteered intent signal, not surveillance.

---

## 0. The problem, stated precisely

The free scan is a genuinely good lead magnet that currently has **no distribution and no return path**:

1. **No propagation.** `/r/<token>` does set `twitter:card` and an `og:image` — but it points every report at the same static `/banner.png`. A report for acme.com and a report for example.org therefore produce **byte-identical** previews in Slack, X, and LinkedIn. The single most shareable artifact we produce carries no information about what was scanned. *(Corrects an earlier draft of this line, which claimed there was no OG image at all.)*
2. **No return path.** The report is a one-shot. `EmailReportForm` exists only to mail a PDF, so the only captured leads are people who wanted a PDF. There is no recurring reason to email a scanned site again.
3. **No third-party surface.** `/stats.js` and `/ad.js` prove we can ship a public embeddable script, but neither is a *funnel* — one is analytics for existing customers, one serves ads. Nobody can put "free AI-readiness check" on their own site and send us the traffic.
4. **No public scan API.** `startAuditFromForm` is a server action only. A prod scan cannot be triggered by `curl`, which blocks any embed, any partner integration, and any bulk flow.

Fixing 1–4 is the whole PRD.

---

## 1. Status / phasing

**Phase 0 — PRD: this document.**

**M1 — Shareable scorecard (OG image): SHIPPED.** Per-report generated card at `app/r/[token]/opengraph-image.tsx`, driven by the pure model in `lib/audit/share-card.ts` (18 unit tests in `tests/share-card.test.ts`), plus the `/slop` landing page and its own static card.

**M2 — Watch this URL (recurring lead capture): SHIPPED (migration not yet applied).** `scan_watches` + double opt-in (`app/actions/watchScan.ts`), a two-phase cron at `app/api/cron/scan-watches` (deliver finished re-scans, then enqueue due ones), score-change email with RFC 8058 one-click stop, and the capture form on `/r/[token]`. Decision logic is pure and tested in `lib/watches.ts` / `tests/watches.test.ts` (21 tests).

> **Deploy order matters:** apply `20260726120000_scan_watches.sql` *after* the code is live. The migration schedules a pg_cron job that POSTs to `/api/cron/scan-watches` every 15 minutes; applied first, that route 404s until the deploy lands.

**M3 — `/scan.js` embeddable widget + public scan API + referral attribution: PLANNED.** ~1 week.

**M4 — Prospect Scan (lead-gen *for customers*, credit-burning): PLANNED, larger.** Revenue-side; ships after M1–M3 prove the funnel.

---

## 2. M1 — Shareable scorecard (the OG image)

**The mechanic:** every shared report becomes an ad that carries the scanned site's own name.

Add `app/r/[token]/opengraph-image.tsx` using Next's `ImageResponse` (already available in Next 16, no new dependency):

- Big score dial — reuse the visual language of `components/report/slop-meter.tsx`.
- The scanned hostname, large. **This is the point**: "acme.com scored 34/100" is a far stronger click than "CrawlProof report".
- One-line headline derived from the findings, e.g. `12 pages with careless defects` or `Blocks GPTBot, ClaudeBot, PerplexityBot`.
- CrawlProof mark, small, bottom-right.

`twitter:card = summary_large_image` was already set on `/r/[token]`, so it only needed the image swapped. Two wiring gotchas found while building it, both worth knowing before adding cards to other routes:

- A page that declares `openGraph.images` **overrides** the generated `opengraph-image.tsx`. The static `/banner.png` had to be *removed* from `generateMetadata` for the card to take effect.
- A page that declares an `openGraph` block but **no** `twitter` block inherits the root layout's `twitter.images` — which also outranks the file convention. `/slop` initially shipped with the new card everywhere and the old banner on X alone. Every page with a generated card needs its own `twitter` block, with neither block declaring `images`.

Also `/slop` gets its own static card (§2.1).

**Why it's first:** it costs a day, it has no schema change, no new endpoint, no privacy surface, and it retroactively upgrades *every report we have ever generated* — all existing share links start rendering as cards the moment it deploys.

**Cache:** the image must be generated from the stored audit row, not by re-running the scan. Cache by `token` + `completed_at`.

### 2.1 `/slop` landing page

The Slop Score is free, deterministic, and runs **no LLM** — so unlike Autoblog it cannot be stalled by a shared provider quota, and unlimited scans cost us nothing but bandwidth. It is therefore the correct engine to put at the top of the funnel, and it currently has no page of its own.

Ship `/slop` as a dedicated landing page: the promise ("find the careless mistakes on your site — free, 50 pages, no signup"), the scan box, and 3–4 real anonymized example findings. Keep the existing hero form on `/` unchanged.

**Positioning guardrail, non-negotiable and already enforced by `tests/slop.test.ts`:** the page reports *observable defects*, never "this was written by AI". An AI-probability claim is unfalsifiable, misfires on non-native English writers, and would accuse paying customers. Marketing copy must not drift into it.

---

## 3. M2 — "Watch this URL" (the recurring lead capture)

**The mechanic:** stop gating the *report*; gate the *ongoing relationship*.

The full report stays 100% visible to anonymous visitors — that is what makes it shareable, and hiding it would kill M1. Instead, three things ask for an email, on the report page itself:

| Ask | Value exchange | Lead quality |
|---|---|---|
| Email me the PDF | *(exists today)* | Medium |
| **Watch this URL** — re-scan weekly, email me when the score changes | **The lead engine** | **High** |
| Export the per-page fix list (CSV/markdown) | Practical | High |

**"Watch this URL" is the important one**, for three reasons:

1. It is **self-qualifying**. Somebody who wants a weekly re-scan of a site is, by definition, someone responsible for that site. That is our buyer. No enrichment, no scoring model needed — the request *is* the qualification.
2. It creates a **recurring, wanted, non-spam reason to email them**. "Your score went from 34 to 51" is a message people open. Every send is a re-entry point to the product, and the unsubscribe is genuine.
3. It **reuses the cron + alerts spine wholesale** — `lib/alerts/`, the uptime re-alert pattern (`20260714124903_uptime_down_realert.sql`), and the existing global unsubscribe route `/unsubscribe/[token]`.

**Implementation notes:**
- New table `scan_watches` (email, target_url, engine, cadence, verified_at, unsubscribed_at, last_score, last_scanned_at). Double opt-in: the first email confirms; nothing recurring sends until `verified_at` is set.
- Tag the resulting audits to the existing **Prospects** org via `audits.organization_id`, so `/recent`'s outreach form can work them without inventing a fake project per lead — which is exactly what `20260606133000_prospects_outreach_configs.sql` was built for.
- Every send carries `List-Unsubscribe` headers (`lib/outreach.ts` already does this) and honours globally-unsubscribed `marketing_contacts`.
- Cap: one watch per email per URL, and a hard cap on watches per email, or this becomes a free monitoring tier by accident.

**Compliance line:** a watch is opt-in, double-confirmed, and about the subscriber's own site. Cold-emailing every domain that ever appeared in `/recent` is a *different activity* with real CAN-SPAM/GDPR exposure — keep the two separated in the code and in the org's habits.

---

## 4. M3 — `/scan.js` embeddable widget + public scan API

**The mechanic:** let other people host our funnel.

This is the Ahrefs-free-tools / "backlink checker embedded on 400 blogs" play, and we are unusually well set up for it because the embeddable-script pattern is already proven twice in this repo (`/stats.js`, 210 lines; `/ad.js`, 105 lines) and the CORS ingest pattern already exists in `/api/track`.

### 4.1 `POST /api/scan` — the missing primitive

There is **no public endpoint to start a scan today** (server action only). Add one:

```
POST /api/scan  { url, engine?: "rule" | "slop", ref?: <referral token> }
  → 202 { token, pollUrl }
```

- Same guardrails as the hero form, not looser: `lib/rateLimit.ts` anonymous per-IP limits, the existing URL-safety checks (no private ranges, no SSRF), and `ANON_ENGINES` restricted to `["rule", "slop"]` — **no LLM engines**, so an abusive embed can never burn provider budget.
- Per-origin rate limit in addition to per-IP, keyed on the embedding site, so one hostile embed cannot exhaust the global pool.
- This endpoint also unblocks partner integrations and the MCP surface generally.

### 4.2 The widget

`GET /scan.js` serves a tiny dependency-free script, same shape as `stats.js`:

```html
<script data-ref="<referral token>" src="https://crawlproof.com/scan.js"></script>
```

Renders an inline "How AI-ready is your site?" input. On submit it calls `/api/scan`, shows the score inline, and links to the full report at `/r/<token>?ref=<referral token>`. Styling inherits from the host page with a minimal reset; failures must never break the host page (same rule as `stats.js`).

### 4.3 Attribution

`lib/referrals.ts` (`@profullstack/stack/referrals`) + `/api/referrals` + `/r/[token]` already exist. Wire the widget's `data-ref` through the scan into the referral store, so an agency or newsletter that embeds the widget earns credits on signups it drives. That gives embedders an actual reason to install it and keep it installed — the same two-sided logic that makes the ad network work.

---

## 5. M4 — Prospect Scan (leads *for the customer*, and revenue for us)

Everything above generates leads **for CrawlProof**. M4 is the other reading of the request: sell lead generation *as a feature*.

**The mechanic:** the customer brings the list; we supply the pitch.

1. Customer uploads or pastes a list of prospect domains (their own list — an event attendee list, a directory export, an industry roster, their existing CRM).
2. CrawlProof bulk-runs the free/cheap engines across the list, worst-first ranked.
3. For each prospect, generate a one-page branded "here's what's broken on your site" PDF — reusing the existing PDF worker and the remediation quote already on the report cover (`4df320c`).
4. Customer exports the ranked list + PDFs and runs **their own** outreach.

**Why this shape and not the obvious one:** the tempting version is visitor de-anonymization — reverse-IP the tracker's traffic into company names. That is the Audience Hub again in a new hat, and it was removed as an info-handling risk. This version touches **no personal data at all**: the input list is the customer's, the scanned sites are public, and CrawlProof is never in the sending path. It's the difference between selling a surveillance product and selling a *sales-collateral generator*.

**Revenue:** bulk scanning is direct credit burn — 200 prospects is 200 scans. It monetizes on the exact axis the platform is already built to bill.

**Check overlap** with `docs/agency-prd.md` (multi-site management) — different thing, but agencies are the buyer for both, so the surfaces should be adjacent in the UI.

---

## 6. What we are explicitly not building

- **Visitor de-anonymization / reverse-IP company identification.** Removed once already (Audience Hub, 2026-06-18) as an info risk. Not reopening it.
- **Contact enrichment / email appending.** Same reason.
- **An "AI-written probability" score** as a lead hook. Unfalsifiable, misfires on non-native speakers, insults customers. `tests/slop.test.ts` guards this.
- **Mass cold-emailing every domain in `/recent`.** The infrastructure could do it; the legal exposure and the brand damage are not worth it, and it would poison the deliverability that M2 depends on.

---

## 7. Sequencing rationale

M1 before everything because it is a day of work that upgrades every report ever generated, and because M3's widget is worthless if the reports it produces don't render when shared. M2 before M3 because there is no point pouring embedded traffic into a funnel with no return path. M4 last because it is the only one that needs the funnel to already work.

**Success signal to watch before committing to M3:** share-link click-through after M1, and watch-signup rate on anonymous reports after M2. If M2's opt-in rate is under a few percent, the value exchange is wrong and M3 will amplify a leak.
