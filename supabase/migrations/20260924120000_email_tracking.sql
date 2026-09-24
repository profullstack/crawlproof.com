-- Email tracking: one tracking URL per project, for mail sent from anywhere.
--
-- WHY: the outreach pixel (/api/o/<token>, outreach_sends.track_token) only
-- works for mail CrawlProof itself sends, because the token is minted per send
-- row. Owners sending from their own tools (myna, a newsletter script) need a
-- stable per-project base URL they can build links from without asking us for
-- a token per message:
--
--   https://crawlproof.com/t/<tracking_id>/o.png?m=&c=&v=        open pixel
--   https://crawlproof.com/t/<tracking_id>/c?u=&m=&c=&v=&s=      click redirect
--   https://crawlproof.com/t/<tracking_id>/u?m=&c=&e=&s=         unsubscribe
--
-- `s` is the first 32 hex chars of HMAC-SHA256(secret, value), so only the
-- secret holder can mint a redirect (no open redirect) or an unsubscribe link.
--
-- WHAT:
--   1. email_tracking: one row per project. tracking_id (public, goes in every
--      email) and secret (never leaves the dashboard or the sender). Off until
--      the owner clicks Enable. previous_secret keeps links in already-sent
--      mail verifiable across one rotation, so an unsubscribe link keeps
--      working after the owner rotates.
--   2. A trigger creates the row for every new project; this file backfills
--      every existing one.
--   3. email_tracking_events: open / click / unsubscribe. No IP in the clear
--      (visitor_hash is the daily-rotating salted hash from lib/ipHash.ts) and
--      no email address except on unsubscribe rows (check constraint).
--   4. email_tracking_stats / email_tracking_top_urls: the Tracking tab.
--
-- RLS: email_tracking has NO policy for authenticated. The secret is read by
-- the server with the service role after requireProjectAccess, so a read-only
-- project member cannot pull it through PostgREST. Events are readable by the
-- project owner and members (mirrors tracker_* tables); the read RPCs are
-- security invoker so they inherit that.
--
-- Idempotent. Apply one file at a time via the Supabase MCP, not `db push`.

-- ---------------------------------------------------------------------------
-- 1. Per-project tracking identity
-- ---------------------------------------------------------------------------
create table if not exists public.email_tracking (
  project_id uuid primary key references public.projects(id) on delete cascade,
  -- 12 random bytes as hex: 24 url-safe chars.
  tracking_id text not null unique default encode(gen_random_bytes(12), 'hex'),
  -- 32 random bytes as hex.
  secret text not null default encode(gen_random_bytes(32), 'hex'),
  previous_secret text,
  secret_rotated_at timestamptz,
  enabled boolean not null default false,
  enabled_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.email_tracking enable row level security;
revoke all on public.email_tracking from anon, authenticated;
grant select, insert, update, delete on public.email_tracking to service_role;

create or replace function public.email_tracking_on_project_insert()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  insert into public.email_tracking (project_id)
  values (new.id)
  on conflict (project_id) do nothing;
  return new;
end;
$$;

revoke all on function public.email_tracking_on_project_insert() from public;

drop trigger if exists email_tracking_on_project_insert on public.projects;
create trigger email_tracking_on_project_insert
  after insert on public.projects
  for each row execute function public.email_tracking_on_project_insert();

-- Backfill: every existing project gets its id and secret now.
insert into public.email_tracking (project_id)
select id from public.projects
on conflict (project_id) do nothing;

-- ---------------------------------------------------------------------------
-- 2. Events
-- ---------------------------------------------------------------------------
create table if not exists public.email_tracking_events (
  id bigint generated always as identity primary key,
  project_id uuid not null references public.projects(id) on delete cascade,
  type text not null check (type in ('open', 'click', 'unsubscribe')),
  m text,
  c text,
  v text,
  url text,
  email text,
  -- Likely a mail proxy or scanner rather than a person. Flagged, never dropped.
  machine boolean not null default false,
  visitor_hash text,
  at timestamptz not null default now(),
  constraint email_tracking_events_email_only_on_unsub
    check (email is null or type = 'unsubscribe'),
  constraint email_tracking_events_url_only_on_click
    check (url is null or type = 'click')
);

-- Events API pagination + the stats window.
create index if not exists email_tracking_events_project_id_idx
  on public.email_tracking_events (project_id, id);
create index if not exists email_tracking_events_project_at_idx
  on public.email_tracking_events (project_id, at);
-- "First sighting" of a message, for the machine-open heuristic.
create index if not exists email_tracking_events_project_m_idx
  on public.email_tracking_events (project_id, m, at) where m is not null;
-- One unsubscribe row per address per project; a second POST is a no-op.
create unique index if not exists email_tracking_events_unsub_once_idx
  on public.email_tracking_events (project_id, email) where type = 'unsubscribe';

alter table public.email_tracking_events enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'email_tracking_events'
      and policyname = 'email_tracking_events owner select'
  ) then
    create policy "email_tracking_events owner select"
      on public.email_tracking_events
      for select
      using (
        project_id in (select id from public.projects where owner_id = auth.uid())
      );
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'email_tracking_events'
      and policyname = 'email_tracking_events member select'
  ) then
    create policy "email_tracking_events member select"
      on public.email_tracking_events
      for select
      using (public.is_project_member(project_id, auth.uid()));
  end if;
end $$;

revoke all on public.email_tracking_events from anon;
grant select on public.email_tracking_events to authenticated;
grant select, insert, update, delete on public.email_tracking_events to service_role;

-- ---------------------------------------------------------------------------
-- 3. Read RPCs for the Tracking tab (security invoker: RLS applies)
-- ---------------------------------------------------------------------------
create or replace function public.email_tracking_stats(
  p_project uuid,
  p_since timestamptz
)
returns table (
  campaign text,
  variant text,
  opens bigint,
  unique_opens bigint,
  machine_opens bigint,
  clicks bigint,
  unique_clicks bigint,
  unsubscribes bigint
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    coalesce(e.c, '') as campaign,
    coalesce(e.v, '') as variant,
    count(*) filter (where e.type = 'open' and not e.machine) as opens,
    count(distinct e.m) filter (where e.type = 'open' and not e.machine) as unique_opens,
    count(*) filter (where e.type = 'open' and e.machine) as machine_opens,
    count(*) filter (where e.type = 'click') as clicks,
    count(distinct e.m) filter (where e.type = 'click') as unique_clicks,
    count(*) filter (where e.type = 'unsubscribe') as unsubscribes
  from public.email_tracking_events e
  where e.project_id = p_project
    and e.at >= p_since
  group by 1, 2
  order by 3 desc, 6 desc, 1, 2
  limit 500;
$$;

grant execute on function public.email_tracking_stats(uuid, timestamptz) to authenticated, service_role;

create or replace function public.email_tracking_top_urls(
  p_project uuid,
  p_since timestamptz,
  p_limit integer default 20
)
returns table (
  campaign text,
  variant text,
  url text,
  clicks bigint,
  unique_clicks bigint
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    coalesce(e.c, '') as campaign,
    coalesce(e.v, '') as variant,
    e.url,
    count(*) as clicks,
    count(distinct e.m) as unique_clicks
  from public.email_tracking_events e
  where e.project_id = p_project
    and e.type = 'click'
    and e.at >= p_since
    and e.url is not null
  group by 1, 2, 3
  order by 4 desc, 3
  limit greatest(1, least(coalesce(p_limit, 20), 100));
$$;

grant execute on function public.email_tracking_top_urls(uuid, timestamptz, integer) to authenticated, service_role;
