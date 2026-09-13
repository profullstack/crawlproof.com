-- Autobid, paper money, and a bid history.
--
-- Every campaign on this network belongs to the account that owns every slot,
-- so serveAd demotes every fill to the free tier and the bid-weighted auction
-- never runs: the free pool weights every campaign at 1. Nobody bids. That
-- means the auction, the pacing and the charge path have never been exercised
-- end to end with real numbers, and there are far more campaigns than there is
-- inventory for them.
--
-- This turns bidding on for everyone, with PAPER money:
--
--   * `autobid` (default TRUE, for existing rows too) hands the bid to a pacing
--     controller (lib/ads/autobid.ts) that raises a campaign behind its daily
--     pace and lowers one ahead of it, capped by what the daily budget could
--     cover. The advertiser sets a budget; the bid is computed and shown.
--   * The free tier becomes a paper auction: the same bid-weighted lottery,
--     weighted by the paper bid and gated by a paper daily budget. Each
--     free-tier click records what it WOULD have cost (`paper_cents`) and the
--     campaign accrues `paper_spend_today_cents`. No credit balance is ever
--     debited and nothing is accrued to a publisher. The paid tier — a funded
--     third party — is untouched and still bills through ad_charge_click.
--   * `ad_bids` keeps every bid decision with the signals that drove it, so a
--     campaign page can plot bid against impressions, clicks and the visits
--     the tracker attributes to it.
--
-- Apply by hand via the Supabase MCP, one file at a time. Every column here is
-- additive with a default, so a deploy that lands either side of it is safe.

alter table public.ad_campaigns
  add column if not exists autobid boolean not null default true,
  add column if not exists bid_updated_at timestamptz,
  add column if not exists paper_spend_today_cents integer not null default 0,
  add column if not exists paper_spend_date date,
  add column if not exists paper_total_cents bigint not null default 0;

-- What the winner bid on this fill. Null on rows written before this landed.
alter table public.ad_impressions
  add column if not exists bid_credits integer;

-- What a free-tier click would have cost at the campaign's bid. Always 0 on a
-- billed click, whose real cost is charged_cents.
alter table public.ad_clicks
  add column if not exists paper_cents integer not null default 0;

create table if not exists public.ad_bids (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.ad_campaigns(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  ts timestamptz not null default now(),
  bid_credits integer not null check (bid_credits > 0),
  prev_bid_credits integer,
  -- auto: the controller. manual: somebody typed it. seed: the first row for a
  -- campaign, so a chart has a starting point.
  source text not null default 'auto' check (source in ('auto', 'manual', 'seed')),
  reason text not null default '',
  signals jsonb not null default '{}'::jsonb
);
create index if not exists ad_bids_campaign_ts_idx on public.ad_bids (campaign_id, ts desc);

alter table public.ad_bids enable row level security;
drop policy if exists ad_bids_owner_read on public.ad_bids;
create policy ad_bids_owner_read on public.ad_bids
  for select using (auth.uid() = owner_id);
-- Writes come from the worker and the server actions through the service role.
revoke insert, update, delete on public.ad_bids from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Paper charge: record what a free-tier click would have cost.
-- ---------------------------------------------------------------------------
-- Separate from ad_charge_click on purpose: that function is the hottest SQL
-- in the product and moves real money. This one moves none. It refuses to
-- touch a click that billed (tier 'paid' or charged_cents > 0), so a paper
-- figure can never be written over a real one.
create or replace function public.ad_paper_charge(
  p_click uuid,
  p_campaign uuid,
  p_cents integer
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_tier text;
  v_spend int;
  v_date date;
begin
  if p_click is null or p_campaign is null or p_cents is null or p_cents <= 0 then
    return;
  end if;

  update public.ad_clicks
     set paper_cents = p_cents
   where id = p_click
     and campaign_id = p_campaign
     and tier = 'free'
     and charged_cents = 0
  returning tier into v_tier;
  if v_tier is null then
    return; -- not a free-tier click; nothing paper about it
  end if;

  select paper_spend_today_cents, paper_spend_date
    into v_spend, v_date
    from public.ad_campaigns
   where id = p_campaign
     for update;
  if not found then return; end if;
  if v_date is distinct from current_date then v_spend := 0; end if;

  update public.ad_campaigns
     set paper_spend_today_cents = v_spend + p_cents,
         paper_spend_date = current_date,
         paper_total_cents = coalesce(paper_total_cents, 0) + p_cents
   where id = p_campaign;
end
$$;

revoke execute on function public.ad_paper_charge(uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.ad_paper_charge(uuid, uuid, integer) to service_role;

-- ---------------------------------------------------------------------------
-- Activity since a moment, per campaign, for the autobid sweep.
-- ---------------------------------------------------------------------------
-- One grouped read over the reporting indexes rather than the raw rows through
-- PostgREST, which caps a response at 1000 rows and a day of impressions is
-- ninety thousand. Clicks count real delivery on both tiers: billed, or free
-- and real. Refused clicks (not valid, tier 'paid') are not delivery.
create or replace function public.ad_autobid_activity(
  p_since timestamptz
)
returns table(campaign_id uuid, impressions bigint, clicks bigint)
language sql
stable
security definer
set search_path to 'public'
as $$
  with i as (
    select imp.campaign_id, count(*) as n
      from public.ad_impressions imp
     where imp.ts >= p_since and not imp.duplicate
     group by imp.campaign_id
  ),
  k as (
    select cl.campaign_id, count(*) as n
      from public.ad_clicks cl
     where cl.ts >= p_since and (cl.valid or cl.tier = 'free')
     group by cl.campaign_id
  )
  select coalesce(i.campaign_id, k.campaign_id) as campaign_id,
         coalesce(i.n, 0)::bigint as impressions,
         coalesce(k.n, 0)::bigint as clicks
    from i
    full outer join k on k.campaign_id = i.campaign_id;
$$;

revoke execute on function public.ad_autobid_activity(timestamptz) from public, anon, authenticated;
grant execute on function public.ad_autobid_activity(timestamptz) to service_role;

-- ---------------------------------------------------------------------------
-- Bid history for one campaign: per UTC day, bid vs delivery, plus the log.
-- ---------------------------------------------------------------------------
-- Returns one jsonb document (the 1000-row cap cannot apply):
--   days       one entry per day in the window, zero-filled, oldest first:
--              impressions (both tiers), won_bid (mean bid on the fills it
--              won), clicks (billed + free), paper_cents, spent_cents, and the
--              bid recorded that day (last, min, max) or null when none was.
--   bids       the most recent 50 bid decisions, newest first.
--   bid_before the last bid recorded before the window, so a caller can carry
--              it forward across days that recorded nothing.
--
-- A session caller sees only their own campaigns. A null uid is the service
-- role, which has already resolved ownership through the bearer token.
create or replace function public.ad_campaign_bid_history(
  p_campaign uuid,
  p_days integer default 30
)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  uid uuid := auth.uid();
  v_owner uuid;
  n int := greatest(coalesce(p_days, 30), 1);
  today date := (now() at time zone 'UTC')::date;
  from_day date;
  from_ts timestamptz;
begin
  select c.owner_id into v_owner from public.ad_campaigns c where c.id = p_campaign;
  if not found then return '{}'::jsonb; end if;
  if uid is not null and uid <> v_owner then return '{}'::jsonb; end if;

  from_day := today - (n - 1);
  from_ts := (from_day::timestamp at time zone 'UTC');

  return jsonb_build_object(
    'days', coalesce((
      select jsonb_agg(row_to_json(d) order by d.day)
        from (
          with axis as (
            select generate_series(from_day, today, interval '1 day')::date as day
          ),
          imp as (
            select ((i.ts at time zone 'UTC')::date) as day,
                   count(*) as impressions,
                   avg(i.bid_credits) filter (where i.bid_credits is not null) as won_bid
              from public.ad_impressions i
             where i.campaign_id = p_campaign and not i.duplicate and i.ts >= from_ts
             group by 1
          ),
          clk as (
            select ((k.ts at time zone 'UTC')::date) as day,
                   count(*) filter (where k.valid or k.tier = 'free') as clicks,
                   coalesce(sum(k.paper_cents), 0) as paper_cents,
                   coalesce(sum(k.charged_cents) filter (where k.valid), 0) as spent_cents
              from public.ad_clicks k
             where k.campaign_id = p_campaign and k.ts >= from_ts
             group by 1
          ),
          bid as (
            select ((b.ts at time zone 'UTC')::date) as day,
                   (array_agg(b.bid_credits order by b.ts desc))[1] as bid,
                   min(b.bid_credits) as min_bid,
                   max(b.bid_credits) as max_bid
              from public.ad_bids b
             where b.campaign_id = p_campaign and b.ts >= from_ts
             group by 1
          )
          select axis.day,
                 coalesce(imp.impressions, 0)::bigint as impressions,
                 round(imp.won_bid::numeric, 2) as won_bid,
                 coalesce(clk.clicks, 0)::bigint as clicks,
                 coalesce(clk.paper_cents, 0)::bigint as paper_cents,
                 coalesce(clk.spent_cents, 0)::bigint as spent_cents,
                 bid.bid,
                 bid.min_bid,
                 bid.max_bid
            from axis
            left join imp on imp.day = axis.day
            left join clk on clk.day = axis.day
            left join bid on bid.day = axis.day
        ) d
    ), '[]'::jsonb),
    'bids', coalesce((
      select jsonb_agg(row_to_json(b) order by b.ts desc)
        from (
          select b.ts, b.bid_credits, b.prev_bid_credits, b.source, b.reason, b.signals
            from public.ad_bids b
           where b.campaign_id = p_campaign
           order by b.ts desc
           limit 50
        ) b
    ), '[]'::jsonb),
    'bid_before', (
      select b.bid_credits
        from public.ad_bids b
       where b.campaign_id = p_campaign and b.ts < from_ts
       order by b.ts desc
       limit 1
    )
  );
end
$$;

revoke execute on function public.ad_campaign_bid_history(uuid, integer) from public, anon;
grant execute on function public.ad_campaign_bid_history(uuid, integer) to authenticated, service_role;
