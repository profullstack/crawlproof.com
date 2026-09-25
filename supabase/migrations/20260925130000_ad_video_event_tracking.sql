-- Make the pre-roll playback tables reachable, and report on them.
--
-- 20260924130000 created ad_video_decisions and ad_video_events and stopped
-- there — work package A was schema only. Nothing has written a row since:
-- the serving path counts a fill in ad_impressions and no code has ever
-- referenced either table. So today a video ad reports exactly what a banner
-- reports (it was served) and nothing a video has that a banner does not
-- (it played, it was watched to the end, it failed to load).
--
-- Two things stand between that schema and a row:
--
--   1. `property_id` is NOT NULL against ad_streaming_properties, and there
--      are zero properties registered. /api/ads/stream authenticates a *slot*,
--      not a property, so every decision it could write is rejected by the
--      column. Properties are the heavier integration (credentialed backends,
--      server-side manifests) and they are still coming; a slot-only break is
--      the one that exists and serves today.
--
--   2. There is no funnel to read. The reporting RPCs all aggregate the
--      impression ledger, which cannot answer a question about playback.
--
-- What this migration deliberately does NOT do is move the impression. The
-- comment on `impression_id` says it is set by the first accepted `start`,
-- which would make a video impression mean "watched" while a banner impression
-- means "served". That is the better definition and it is not worth a second
-- metering path to get: serveAd owns the ledger for every format, the auction
-- and the duplicate rules live there, and a second writer is how two sets of
-- numbers start. So the fill-time impression stays, the decision records which
-- impression it was, and the funnel below reports fills and starts as separate
-- columns so nobody can mistake one for the other.
--
-- NOTE: prod migration history diverged — apply this single file via psql over
-- the pooler, do NOT `supabase db push`.

-- 1. A decision may belong to a slot instead of a property. -------------------

alter table public.ad_video_decisions alter column property_id drop not null;

-- One of the two has to identify where the break happened, or the row is an
-- orphan measurement of nothing.
alter table public.ad_video_decisions
  drop constraint if exists ad_video_decisions_placement_source;
alter table public.ad_video_decisions
  add constraint ad_video_decisions_placement_source
  check (property_id is not null or slot_id is not null);

-- The per-session pre-roll rule, for the slot-only case. The original unique
-- index is on (property_id, playback_session_id, placement) and NULLs compare
-- distinct in a unique index, so with no property it enforces nothing at all —
-- a remount would stack a second ad onto a session that already had one.
create unique index if not exists ad_video_decisions_slot_session_key
  on public.ad_video_decisions(slot_id, playback_session_id, placement)
  where property_id is null;

-- 2. Which inventory filled the break. ----------------------------------------
--
-- Recoverable by joining the impression, except for the case that matters
-- most right now: a house fill is never metered, so it has no impression to
-- join and would be indistinguishable from an unfilled break. Storing the
-- tier is what lets a publisher see that their break played *something*.
alter table public.ad_video_decisions
  add column if not exists tier text check (tier in ('paid', 'free', 'house'));

-- 3. Reporting. ---------------------------------------------------------------
--
-- Two questions, two sides of the market: an advertiser asks about their
-- campaigns, a publisher asks about their slots.
--
-- Each is a pair, following ad_token_earnings (20260913170000): a
-- `_for(owner, days)` core that is service_role only, and a thin auth.uid()
-- wrapper the dashboard calls. The core is what the bearer-token API and the
-- CLI use, where there is no auth.uid() to read; splitting them is what keeps
-- "which owner" a decision the server makes rather than a parameter a browser
-- could supply.
--
-- `fills` and `starts` are separate on purpose and neither is an impression:
-- a fill is a decision handed to a player, a start is a player reporting that
-- the first frame ran. The gap between them is the ad that was chosen and
-- never seen, which is the number this whole migration exists to expose.
--
-- `played_ms` is the sum over decisions of the furthest point each one
-- reached, not the sum of every event's played_ms — the quartile beacons all
-- carry a running total, so adding them up counts the same second four times.

create or replace function public.ad_video_funnel_for(p_owner uuid, p_days integer default 7)
returns table(
  campaign_id uuid,
  campaign_name text,
  fills bigint,
  starts bigint,
  first_quartile bigint,
  midpoint bigint,
  third_quartile bigint,
  completes bigint,
  clicks bigint,
  errors bigint,
  abandons bigint,
  played_ms bigint
)
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  since timestamptz := now() - make_interval(days => greatest(coalesce(p_days, 7), 1));
begin
  if p_owner is null then
    return;
  end if;

  return query
  with mine as (
    select d.id, d.campaign_id
    from public.ad_video_decisions d
    join public.ad_campaigns c on c.id = d.campaign_id
    where c.owner_id = p_owner and d.created_at >= since
  ),
  ev as (
    select m.campaign_id, e.decision_id, e.event_type, e.played_ms
    from mine m
    join public.ad_video_events e on e.decision_id = m.id
  ),
  furthest as (
    select f.campaign_id, sum(f.mx)::bigint as played_ms
    from (
      select ev.campaign_id, ev.decision_id, max(coalesce(ev.played_ms, 0)) as mx
      from ev group by 1, 2
    ) f
    group by 1
  ),
  agg as (
    select
      m.campaign_id as cid,
      count(distinct m.id)::bigint as fills,
      count(distinct e.decision_id) filter (where e.event_type = 'start')::bigint as starts,
      count(distinct e.decision_id) filter (where e.event_type = 'first_quartile')::bigint as q1,
      count(distinct e.decision_id) filter (where e.event_type = 'midpoint')::bigint as mid,
      count(distinct e.decision_id) filter (where e.event_type = 'third_quartile')::bigint as q3,
      count(distinct e.decision_id) filter (where e.event_type = 'complete')::bigint as completes,
      count(distinct e.decision_id) filter (where e.event_type = 'click')::bigint as clicks,
      count(distinct e.decision_id) filter (where e.event_type = 'error')::bigint as errors,
      count(distinct e.decision_id) filter (where e.event_type = 'abandon')::bigint as abandons
    from mine m
    left join ev e on e.decision_id = m.id
    group by 1
  )
  select
    c.id, c.name, a.fills, a.starts, a.q1, a.mid, a.q3,
    a.completes, a.clicks, a.errors, a.abandons,
    coalesce(f.played_ms, 0)::bigint
  from agg a
  join public.ad_campaigns c on c.id = a.cid
  left join furthest f on f.campaign_id = a.cid
  order by a.fills desc, c.name;
end;
$$;

create or replace function public.ad_video_funnel(p_days integer default 7)
returns table(
  campaign_id uuid,
  campaign_name text,
  fills bigint,
  starts bigint,
  first_quartile bigint,
  midpoint bigint,
  third_quartile bigint,
  completes bigint,
  clicks bigint,
  errors bigint,
  abandons bigint,
  played_ms bigint
)
language sql
stable
security definer
set search_path to 'public'
as $$
  select * from public.ad_video_funnel_for(auth.uid(), p_days);
$$;

-- The publisher's half. House fills are counted and broken out: an unsold
-- break that plays the house pre-roll is inventory doing its job, and leaving
-- it out would show a working slot as empty.
create or replace function public.ad_video_slot_funnel_for(p_owner uuid, p_days integer default 7)
returns table(
  slot_id uuid,
  project_name text,
  fills bigint,
  house_fills bigint,
  unfilled bigint,
  starts bigint,
  completes bigint,
  clicks bigint,
  errors bigint,
  abandons bigint,
  played_ms bigint
)
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  since timestamptz := now() - make_interval(days => greatest(coalesce(p_days, 7), 1));
begin
  if p_owner is null then
    return;
  end if;

  return query
  with mine as (
    select d.id, d.slot_id, d.tier, d.result
    from public.ad_video_decisions d
    join public.ad_slots s on s.id = d.slot_id
    where s.owner_id = p_owner and d.created_at >= since
  ),
  ev as (
    select m.slot_id, e.decision_id, e.event_type, e.played_ms
    from mine m
    join public.ad_video_events e on e.decision_id = m.id
  ),
  furthest as (
    select f.slot_id, sum(f.mx)::bigint as played_ms
    from (
      select ev.slot_id, ev.decision_id, max(coalesce(ev.played_ms, 0)) as mx
      from ev group by 1, 2
    ) f
    group by 1
  ),
  agg as (
    select
      m.slot_id as sid,
      count(distinct m.id)::bigint as fills,
      count(distinct m.id) filter (where m.tier = 'house')::bigint as house_fills,
      count(distinct m.id) filter (where m.result = 'no_ad')::bigint as unfilled,
      count(distinct e.decision_id) filter (where e.event_type = 'start')::bigint as starts,
      count(distinct e.decision_id) filter (where e.event_type = 'complete')::bigint as completes,
      count(distinct e.decision_id) filter (where e.event_type = 'click')::bigint as clicks,
      count(distinct e.decision_id) filter (where e.event_type = 'error')::bigint as errors,
      count(distinct e.decision_id) filter (where e.event_type = 'abandon')::bigint as abandons
    from mine m
    left join ev e on e.decision_id = m.id
    group by 1
  )
  select
    s.id, coalesce(p.name, ''), a.fills, a.house_fills, a.unfilled,
    a.starts, a.completes, a.clicks, a.errors, a.abandons,
    coalesce(f.played_ms, 0)::bigint
  from agg a
  join public.ad_slots s on s.id = a.sid
  left join public.projects p on p.id = s.project_id
  left join furthest f on f.slot_id = a.sid
  order by a.fills desc;
end;
$$;

create or replace function public.ad_video_slot_funnel(p_days integer default 7)
returns table(
  slot_id uuid,
  project_name text,
  fills bigint,
  house_fills bigint,
  unfilled bigint,
  starts bigint,
  completes bigint,
  clicks bigint,
  errors bigint,
  abandons bigint,
  played_ms bigint
)
language sql
stable
security definer
set search_path to 'public'
as $$
  select * from public.ad_video_slot_funnel_for(auth.uid(), p_days);
$$;

-- The owner is the server's to decide, never the caller's.
revoke all on function public.ad_video_funnel_for(uuid, integer) from public, anon, authenticated;
revoke all on function public.ad_video_slot_funnel_for(uuid, integer) from public, anon, authenticated;
grant execute on function public.ad_video_funnel_for(uuid, integer) to service_role;
grant execute on function public.ad_video_slot_funnel_for(uuid, integer) to service_role;

grant execute on function public.ad_video_funnel(integer) to authenticated;
grant execute on function public.ad_video_slot_funnel(integer) to authenticated;
