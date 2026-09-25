-- Split the video funnel by placement, because a pre-roll and an in-banner
-- video are not the same product and must not share a completion rate.
--
-- 20260925130000 built the funnel when the only video ad was the streaming
-- pre-roll. In-banner video (20260925120000's media rotation, serving now)
-- reports through the same tables, and merging them would produce a number
-- that means nothing:
--
--   * a pre-roll is watched by someone waiting for their content; an in-banner
--     video is muted, autoplaying and looping in the corner of a page nobody
--     opened for it. Completion means something different in each.
--   * only the first loop of a banner is counted, so its "complete" is a
--     different event from a pre-roll's, produced by different logic.
--
-- So `placement` becomes an output column and a grouping key. The functions are
-- DROPped rather than replaced: `create or replace` cannot change a function's
-- return type.
--
-- NOTE: prod migration history diverged — apply this single file via psql over
-- the pooler, do NOT `supabase db push`.

drop function if exists public.ad_video_funnel(integer);
drop function if exists public.ad_video_funnel_for(uuid, integer);
drop function if exists public.ad_video_slot_funnel(integer);
drop function if exists public.ad_video_slot_funnel_for(uuid, integer);

create or replace function public.ad_video_funnel_for(p_owner uuid, p_days integer default 7)
returns table(
  campaign_id uuid,
  campaign_name text,
  placement text,
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
    select d.id, d.campaign_id, d.placement
    from public.ad_video_decisions d
    join public.ad_campaigns c on c.id = d.campaign_id
    where c.owner_id = p_owner and d.created_at >= since
  ),
  ev as (
    select m.campaign_id, m.placement, e.decision_id, e.event_type, e.played_ms
    from mine m
    join public.ad_video_events e on e.decision_id = m.id
  ),
  furthest as (
    select f.campaign_id, f.placement, sum(f.mx)::bigint as played_ms
    from (
      select ev.campaign_id, ev.placement, ev.decision_id, max(coalesce(ev.played_ms, 0)) as mx
      from ev group by 1, 2, 3
    ) f
    group by 1, 2
  ),
  agg as (
    select
      m.campaign_id as cid,
      m.placement as plc,
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
    group by 1, 2
  )
  select
    c.id, c.name, a.plc, a.fills, a.starts, a.q1, a.mid, a.q3,
    a.completes, a.clicks, a.errors, a.abandons,
    coalesce(f.played_ms, 0)::bigint
  from agg a
  join public.ad_campaigns c on c.id = a.cid
  left join furthest f on f.campaign_id = a.cid and f.placement = a.plc
  order by a.fills desc, c.name, a.plc;
end;
$$;

create or replace function public.ad_video_funnel(p_days integer default 7)
returns table(
  campaign_id uuid,
  campaign_name text,
  placement text,
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

create or replace function public.ad_video_slot_funnel_for(p_owner uuid, p_days integer default 7)
returns table(
  slot_id uuid,
  project_name text,
  placement text,
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
    select d.id, d.slot_id, d.tier, d.result, d.placement
    from public.ad_video_decisions d
    join public.ad_slots s on s.id = d.slot_id
    where s.owner_id = p_owner and d.created_at >= since
  ),
  ev as (
    select m.slot_id, m.placement, e.decision_id, e.event_type, e.played_ms
    from mine m
    join public.ad_video_events e on e.decision_id = m.id
  ),
  furthest as (
    select f.slot_id, f.placement, sum(f.mx)::bigint as played_ms
    from (
      select ev.slot_id, ev.placement, ev.decision_id, max(coalesce(ev.played_ms, 0)) as mx
      from ev group by 1, 2, 3
    ) f
    group by 1, 2
  ),
  agg as (
    select
      m.slot_id as sid,
      m.placement as plc,
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
    group by 1, 2
  )
  select
    s.id, coalesce(p.name, ''), a.plc, a.fills, a.house_fills, a.unfilled,
    a.starts, a.completes, a.clicks, a.errors, a.abandons,
    coalesce(f.played_ms, 0)::bigint
  from agg a
  join public.ad_slots s on s.id = a.sid
  left join public.projects p on p.id = s.project_id
  left join furthest f on f.slot_id = a.sid and f.placement = a.plc
  order by a.fills desc, a.plc;
end;
$$;

create or replace function public.ad_video_slot_funnel(p_days integer default 7)
returns table(
  slot_id uuid,
  project_name text,
  placement text,
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

revoke all on function public.ad_video_funnel_for(uuid, integer) from public, anon, authenticated;
revoke all on function public.ad_video_slot_funnel_for(uuid, integer) from public, anon, authenticated;
grant execute on function public.ad_video_funnel_for(uuid, integer) to service_role;
grant execute on function public.ad_video_slot_funnel_for(uuid, integer) to service_role;
grant execute on function public.ad_video_funnel(integer) to authenticated;
grant execute on function public.ad_video_slot_funnel(integer) to authenticated;

-- PostgREST caches the schema; a hand-applied migration that changes a
-- function signature is invisible to the API until it is told.
notify pgrst, 'reload schema';
