-- Raw tracker events table for real-time "active in last 30 min" view.
-- Only holds the last 24 hours of data; older rows are pruned by the
-- ingest endpoint (fire-and-forget DELETE on every write).
--
-- Intentionally minimal: no IP, no user agent string, no query strings.
-- Just enough to answer "who visited what page, from where, recently."

create table public.tracker_events (
  id           bigserial    primary key,
  project_id   uuid         not null references public.projects(id) on delete cascade,
  occurred_at  timestamptz  not null default now(),
  event        text         not null default 'pageview',
  page_path    text         not null default '',
  referrer_host text        not null default '',
  event_target text         not null default '',
  bucket       text         not null default '',
  country_code text         not null default '',
  country_name text         not null default '',
  city         text         not null default '',
  visitor_id   text         not null default '',
  session_id   text         not null default ''
);

-- Fast range-scan for "last N minutes" queries.
create index tracker_events_project_time_idx
  on public.tracker_events(project_id, occurred_at desc);

alter table public.tracker_events enable row level security;

-- Owner can read their own project's events.
create policy "tracker_events owner select"
  on public.tracker_events for select
  using (public.is_project_member(project_id, auth.uid())
      or project_id in (select id from public.projects where owner_id = auth.uid()));
