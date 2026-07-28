-- Record what a run charged.
--
-- Lead generation is billed per run, and until now the only place that figure
-- existed was the constant used to deduct it. A user looking at a balance that
-- has moved could see which campaigns ran but not what any of them cost, which
-- makes "why did my credits go down" unanswerable from the product.
--
-- Zero is the honest default, not null: a tick that found nothing to do is not
-- charged at all, and every historical run predates billing entirely.

alter table public.outreach_campaign_runs
  add column if not exists credits_spent integer not null default 0;

comment on column public.outreach_campaign_runs.credits_spent is
  'Credits charged for this run. Zero when the tick found no billable work, or for runs that predate billing.';
