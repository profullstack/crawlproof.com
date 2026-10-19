-- Destination link health for ad campaigns.
--
-- The worker's ad link sweep (lib/ads/linkHealth.ts) fetches every active
-- campaign's destination_url on a clock and pauses the ones whose page is gone
-- (404/410, or a host that no longer resolves), so the live list stops sending
-- readers to dead pages. It records why on the campaign, and re-activates a
-- campaign it paused once the page answers again.
--
-- paused_reason is the checker's mark. Any status change that does not also set
-- paused_reason (the dashboard, the API, the CLI) clears it, so a campaign the
-- advertiser paused or resumed by hand is never touched again by the sweep.

alter table public.ad_campaigns
  add column if not exists paused_reason text,
  add column if not exists link_status text,
  add column if not exists link_http_status integer,
  add column if not exists link_error text,
  add column if not exists link_checked_at timestamptz,
  add column if not exists link_dead_since timestamptz,
  add column if not exists link_dead_checks integer not null default 0;

alter table public.ad_campaigns drop constraint if exists ad_campaigns_link_status_check;
alter table public.ad_campaigns add constraint ad_campaigns_link_status_check
  check (link_status is null or link_status in ('ok', 'dead', 'unknown'));

create index if not exists ad_campaigns_link_checked_idx
  on public.ad_campaigns (link_checked_at nulls first)
  where status in ('active', 'exhausted', 'paused');

create or replace function public.ad_campaigns_clear_paused_reason()
returns trigger
language plpgsql
as $$
begin
  if new.status is distinct from old.status
     and new.paused_reason is not distinct from old.paused_reason then
    new.paused_reason := null;
  end if;
  return new;
end;
$$;

drop trigger if exists ad_campaigns_clear_paused_reason on public.ad_campaigns;
create trigger ad_campaigns_clear_paused_reason
  before update of status on public.ad_campaigns
  for each row execute function public.ad_campaigns_clear_paused_reason();
