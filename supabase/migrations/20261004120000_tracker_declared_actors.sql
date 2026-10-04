-- Declared actors: a visitor may say who it is, and whether it is a person.
--
-- WHY: nothing on the wire separates a person from an agent driving a real
-- browser. The tracker guesses from the user agent and the scripted cap, and
-- an undeclared agent in Chrome reads as a human visit. This adds the honest
-- half: an opt-in declaration. A signed-in account registers ACTORS (an
-- email, a name, and a kind: human or agent; an agent may name the human who
-- runs it), mints a secret token per browser or agent, and the visitor sends
-- that token with the beacon. The route never accepts a bare email.
--
-- TRUST RULE (lib/tracker/actors.ts, applyDeclaration): a declaration can
-- only move a hit toward the bot side. "agent" is believed and counts the hit
-- as bot:declared. "human" is recorded but never overrides detection: a
-- declared human the user agent or the scripted cap calls a bot stays a bot,
-- and the hit is counted as a contradiction against that actor.
--
-- PRIVACY: an actor's identity is visible to its owner only (visibility
-- 'private', the default). Another site's owner sees declared counts per
-- kind, never the email. The ingest route and API read with the service role;
-- RLS here keeps the tables owner-scoped for anything that reads as a user.
--
-- WHAT:
--   1. tracker_actors           — who: email, name, kind, operator, visibility
--   2. tracker_actor_tokens     — credentials, hashed like sp_api_token
--   3. tracker_actor_daily_stats — per (project, day, actor) counts
--   4. tracker_events.actor_id  — the live view can say which actor
--   5. tracker_touch_actor      — the per-beacon upsert
--   6. tracker_declared_totals  — per-kind totals for a project and window
--
-- Idempotent. Deploys do not run migrations: apply by hand after merge.

-- ---------------------------------------------------------------------------
-- 1. Actors
-- ---------------------------------------------------------------------------
create table if not exists public.tracker_actors (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  email text not null check (length(email) between 3 and 320 and position('@' in email) > 1),
  name text not null default '' check (length(name) <= 120),
  kind text not null check (kind in ('human', 'agent')),
  -- The human an agent acts for. Must be another actor of the same owner;
  -- enforced in the API (a check constraint cannot see another row).
  operator_actor_id uuid references public.tracker_actors(id) on delete set null,
  visibility text not null default 'private' check (visibility in ('private', 'public')),
  -- Set when the address proved it receives mail (or is the owner's login).
  email_verified_at timestamptz,
  verify_token_hash text,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

-- One live, verified claim per address across every account, so nobody can
-- register a verified anthony@ after the real one has. Unverified rows are
-- labels only and may repeat.
create unique index if not exists tracker_actors_verified_email_uidx
  on public.tracker_actors (lower(email))
  where email_verified_at is not null and revoked_at is null;

create index if not exists tracker_actors_owner_idx
  on public.tracker_actors (owner_id) where revoked_at is null;

alter table public.tracker_actors enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'tracker_actors'
      and policyname = 'tracker_actors owner select'
  ) then
    create policy "tracker_actors owner select"
      on public.tracker_actors for select
      using (owner_id = auth.uid());
  end if;
end $$;

grant select on public.tracker_actors to authenticated;
grant select, insert, update, delete on public.tracker_actors to service_role;

-- ---------------------------------------------------------------------------
-- 2. Tokens (one per browser or agent; revoke one without the rest)
-- ---------------------------------------------------------------------------
create table if not exists public.tracker_actor_tokens (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid not null references public.tracker_actors(id) on delete cascade,
  prefix text not null,
  token_hash text not null unique,
  label text not null default '' check (length(label) <= 200),
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

create index if not exists tracker_actor_tokens_actor_idx
  on public.tracker_actor_tokens (actor_id);

alter table public.tracker_actor_tokens enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'tracker_actor_tokens'
      and policyname = 'tracker_actor_tokens owner select'
  ) then
    create policy "tracker_actor_tokens owner select"
      on public.tracker_actor_tokens for select
      using (actor_id in (select id from public.tracker_actors where owner_id = auth.uid()));
  end if;
end $$;

grant select on public.tracker_actor_tokens to authenticated;
grant select, insert, update, delete on public.tracker_actor_tokens to service_role;

-- ---------------------------------------------------------------------------
-- 3. Per (project, day, actor) rollup
-- ---------------------------------------------------------------------------
create table if not exists public.tracker_actor_daily_stats (
  project_id uuid not null references public.projects(id) on delete cascade,
  day date not null,
  actor_id uuid not null references public.tracker_actors(id) on delete cascade,
  -- Copied from the actor at write time so per-kind totals need no join
  -- (and so a project owner can count kinds without reading tracker_actors).
  declared_kind text not null check (declared_kind in ('human', 'agent')),
  events integer not null default 0,
  pageviews integer not null default 0,
  -- Hits where the declaration said human and detection said bot.
  contradictions integer not null default 0,
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  primary key (project_id, day, actor_id)
);

create index if not exists tracker_actor_daily_stats_actor_idx
  on public.tracker_actor_daily_stats (actor_id, day);

alter table public.tracker_actor_daily_stats enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'tracker_actor_daily_stats'
      and policyname = 'tracker_actor_daily_stats project owner select'
  ) then
    create policy "tracker_actor_daily_stats project owner select"
      on public.tracker_actor_daily_stats for select
      using (project_id in (select id from public.projects where owner_id = auth.uid()));
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'tracker_actor_daily_stats'
      and policyname = 'tracker_actor_daily_stats member select'
  ) then
    create policy "tracker_actor_daily_stats member select"
      on public.tracker_actor_daily_stats for select
      using (public.is_project_member(project_id, auth.uid()));
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'tracker_actor_daily_stats'
      and policyname = 'tracker_actor_daily_stats actor owner select'
  ) then
    create policy "tracker_actor_daily_stats actor owner select"
      on public.tracker_actor_daily_stats for select
      using (actor_id in (select id from public.tracker_actors where owner_id = auth.uid()));
  end if;
end $$;

grant select on public.tracker_actor_daily_stats to authenticated;
grant select, insert, update, delete on public.tracker_actor_daily_stats to service_role;

-- ---------------------------------------------------------------------------
-- 4. Raw events learn the actor
-- ---------------------------------------------------------------------------
alter table public.tracker_events
  add column if not exists actor_id uuid references public.tracker_actors(id) on delete set null;

-- ---------------------------------------------------------------------------
-- 5. Per-beacon touch
-- ---------------------------------------------------------------------------
create or replace function public.tracker_touch_actor(
  p_project uuid,
  p_day date,
  p_actor uuid,
  p_declared_kind text,
  p_pageview boolean,
  p_contradiction boolean
)
returns void
language sql
volatile
security invoker
set search_path = public
as $$
  insert into public.tracker_actor_daily_stats as s
    (project_id, day, actor_id, declared_kind, events, pageviews, contradictions, first_seen, last_seen)
  values
    (p_project, p_day, p_actor, p_declared_kind, 1,
     case when p_pageview then 1 else 0 end,
     case when p_contradiction then 1 else 0 end,
     now(), now())
  on conflict (project_id, day, actor_id) do update set
    declared_kind = excluded.declared_kind,
    events = s.events + 1,
    pageviews = s.pageviews + excluded.pageviews,
    contradictions = s.contradictions + excluded.contradictions,
    last_seen = now();
$$;

revoke all on function public.tracker_touch_actor(uuid, date, uuid, text, boolean, boolean) from public, anon, authenticated;
grant execute on function public.tracker_touch_actor(uuid, date, uuid, text, boolean, boolean) to service_role;

-- ---------------------------------------------------------------------------
-- 6. Per-kind totals for a project over [p_since, today]
-- ---------------------------------------------------------------------------
create or replace function public.tracker_declared_totals(
  p_project uuid,
  p_since date
)
returns table (
  declared_kind text,
  actors bigint,
  events bigint,
  pageviews bigint,
  contradictions bigint
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    s.declared_kind,
    count(distinct s.actor_id) as actors,
    coalesce(sum(s.events), 0) as events,
    coalesce(sum(s.pageviews), 0) as pageviews,
    coalesce(sum(s.contradictions), 0) as contradictions
  from public.tracker_actor_daily_stats s
  where s.project_id = p_project and s.day >= p_since
  group by s.declared_kind;
$$;

grant execute on function public.tracker_declared_totals(uuid, date) to authenticated, service_role;
