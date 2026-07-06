-- Uptime monitoring V1 (uptime-monitoring-prd.md §3–§7): HTTP/keyword/SSL/TCP
-- monitors with an up/down state machine and incident tracking. The worker
-- runs due checks; down/recovery alerts go out by email.

create table if not exists public.monitors (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  name text not null,
  type text not null check (type in ('http', 'keyword', 'ssl', 'tcp')),
  target text not null,
  config jsonb not null default '{}',
  interval_s int not null default 60,
  timeout_s int not null default 10,
  fail_threshold int not null default 2,
  recover_threshold int not null default 1,
  enabled boolean not null default true,
  current_state text not null default 'unknown'
    check (current_state in ('up', 'down', 'unknown')),
  consecutive_failures int not null default 0,
  consecutive_successes int not null default 0,
  last_checked_at timestamptz,
  last_error text,
  last_response_ms int,
  alert_email text,
  due_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index if not exists monitors_due_idx on public.monitors(enabled, due_at);
create index if not exists monitors_project_idx on public.monitors(project_id);

create table if not exists public.monitor_incidents (
  id uuid primary key default gen_random_uuid(),
  monitor_id uuid not null references public.monitors(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  cause text,
  duration_s int
);
create index if not exists monitor_incidents_monitor_idx
  on public.monitor_incidents(monitor_id, started_at desc);

create table if not exists public.monitor_checks (
  id bigint generated always as identity primary key,
  monitor_id uuid not null references public.monitors(id) on delete cascade,
  checked_at timestamptz not null default now(),
  ok boolean not null,
  response_ms int,
  status_code int,
  error text
);
create index if not exists monitor_checks_monitor_idx
  on public.monitor_checks(monitor_id, checked_at desc);

alter table public.monitors enable row level security;
alter table public.monitor_incidents enable row level security;
alter table public.monitor_checks enable row level security;

-- Owner-scoped, matching public.project_repos / public.port_scans.
create policy "monitors owner select" on public.monitors for select
  using (project_id in (select id from public.projects where owner_id = auth.uid()));
create policy "monitors owner insert" on public.monitors for insert
  with check (project_id in (select id from public.projects where owner_id = auth.uid()));
create policy "monitors owner update" on public.monitors for update
  using (project_id in (select id from public.projects where owner_id = auth.uid()));
create policy "monitors owner delete" on public.monitors for delete
  using (project_id in (select id from public.projects where owner_id = auth.uid()));

create policy "monitor_incidents owner select" on public.monitor_incidents for select
  using (project_id in (select id from public.projects where owner_id = auth.uid()));

create policy "monitor_checks owner select" on public.monitor_checks for select
  using (monitor_id in (
    select m.id from public.monitors m
    join public.projects p on p.id = m.project_id
    where p.owner_id = auth.uid()
  ));
