# CrawlProof 30-day validation test

PRD dated 2026-11-18. Pass: 10 paying subscribers and 100 self-run audits by day 30. Stop: under 3 paying.
This file records what was built for it and how to run it.

## What shipped (P0)

| ID | Requirement | Where |
| --- | --- | --- |
| R1 | Homepage sells only the audit and weekly monitoring; one CTA, "Run a free audit" | `app/(marketing)/page.tsx`, `components/site-header.tsx` |
| R2 | Permanent public report: score, top 5 fixes, "Monitor this site weekly"; OG card with site + score; outreach reports `noindex` | `app/r/[token]/page.tsx`, `lib/audit/top-fixes.ts` |
| R3 | Solo $49/mo (1 site), Agency $199/mo (20 sites); weekly re-run, email on change; self-serve cancel | `lib/monitoring.ts`, `/monitor`, `/dashboard/monitoring` |
| R4 | Batch audit: CSV in, `domain,score,top_issue,report_url` out | `crawlproof batch`, `/api/admin/batch-audits` |
| R5 | Public ranking with date, method and dispute instructions | `/rankings/<slug>`, `crawlproof ranking publish` |
| R6 | Funnel events with source; weekly counts in one query | `funnel_events`, `funnel_weekly`, `lib/funnel.ts` |
| R7 | Outreach rules | Process, not code: plain text, named sender, postal address, opt-out, one follow-up |

## Payments: card without Stripe

Stripe is not an option (standing rule). Checkout is a CoinPay hosted session: any coin, or a card
through PayPal guest checkout. CoinPay cannot charge a card on file, so a month is paid up front:

- First payment activates the plan for 30 days and puts the originating report's site on it.
- 5 days before the month ends the subscriber is emailed a pay link; paying early extends from the
  current end date.
- Unpaid 3 days after the end, the plan expires and its watches stop. Paying again restarts them.
- Cancel sets `cancel_at_period_end`; monitoring runs to the end of the paid month.

The sweep runs inside the existing `crawlproof-scan-watches` pg_cron tick (every 15 min).
Each site on a plan is a pre-verified `scan_watches` row (`subscription_id` set), so re-scans and
change emails reuse the existing watch pipeline.

## Running the test

Admin commands need a `crp_` token of an admin account (`CRAWLPROOF_TOKEN`).

```sh
# Day 6+: 25 outreach audits a day
crawlproof batch agencies-day06.csv --source outreach --out day06-results.csv
# links carry ?src=outreach; reports are noindex

# Day 10: the ranking
crawlproof batch yc-f26.csv --source ranking --out ranking.csv      # prints the batch id
crawlproof ranking publish --slug yc-f26-ai-visibility \
  --title "How visible are YC F26 companies to AI search?" \
  --list "Y Combinator Fall 2026 batch" \
  --method "Each company's homepage was audited with the CrawlProof rule engine on <date>..." \
  --batch <batch_id>
# Dispute or fix: re-run that domain into the same batch; the latest run wins.
crawlproof batch fixed.csv --source ranking --batch <batch_id>
```

Weekly funnel numbers (prod DB):

```sql
select * from funnel_weekly order by week desc, source, event;
-- self-run audits = audit_completed (batch, watch and project audits never emit it)
-- second-day visitors:
select count(*) from (
  select visitor_id from funnel_events where visitor_id is not null
  group by visitor_id having count(distinct created_at::date) >= 2) v;
-- paying subscribers:
select plan, count(*) from monitor_subscriptions where status = 'active' group by plan;
```

## Notes

- `signup` is recorded on the email-confirmation callback within 30 minutes of account creation.
- `report_viewed` is a browser beacon, deduplicated per visitor per report per day.
- Migration `20261118120000_validation_funnel_monitoring.sql` was applied to prod on 2026-11-18.
  After applying any migration by hand, reload PostgREST's schema cache with
  `docker kill -s SIGUSR1 supabase-rest`: `NOTIFY pgrst` is not heard on this stack, and until
  the reload every insert into a new table fails as "not in the schema cache".
