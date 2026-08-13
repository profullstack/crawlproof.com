-- Let a campaign rest its search queries after they stop producing.
--
-- The funnel gate in runEmailCampaignTick counts only prospects still in
-- flight, so a campaign that has contacted everyone it found reads as empty
-- forever and re-runs its identical query list every fifteen minutes, paying
-- full search price for hosts it already has. Three active campaigns at five
-- queries a tick worked out to ~43k ValueSERP searches a month against a 25k
-- plan, which emptied the quota in six days and left discovery returning
-- HTTP 402 for the rest of the cycle.
--
-- These two columns let an unproductive pass wait longer before trying again
-- (30m doubling to a 24h ceiling) instead of capping how many leads a campaign
-- may ever find. One new result clears the streak and restores full speed.

alter table public.outreach_campaigns
  add column if not exists discovery_backoff_until timestamptz,
  add column if not exists discovery_dry_streak int not null default 0;

comment on column public.outreach_campaigns.discovery_backoff_until is
  'When discovery may next run for this campaign. Null means immediately.';
comment on column public.outreach_campaigns.discovery_dry_streak is
  'Consecutive discovery passes that produced no prospect, person or intent signal.';

-- The runner reads active campaigns oldest-tick-first every 15 minutes; the
-- back-off column is checked on each of those rows.
create index if not exists outreach_campaigns_discovery_backoff_idx
  on public.outreach_campaigns (discovery_backoff_until)
  where active;
