-- Exposed-services / port-drift scans (docs/uptime-monitoring-prd.md §12).
-- A scan records a requested/completed port scan of a project's host; findings
-- are the individual open ports, diffed against an accepted baseline. The actual
-- scanning runs on the off-Railway prober droplet; these tables are the web-app
-- surface (request a scan, view history + findings).

create table if not exists public.port_scans (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  host text not null,
  status text not null default 'queued'
    check (status in ('queued', 'running', 'done', 'failed')),
  open_ports int[] not null default '{}',
  error text,
  requested_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists port_scans_project_idx
  on public.port_scans(project_id, created_at desc);

create table if not exists public.port_findings (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  scan_id uuid references public.port_scans(id) on delete set null,
  port int not null,
  service text,
  severity text not null default 'medium'
    check (severity in ('low', 'medium', 'high')),
  state text not null default 'open'
    check (state in ('open', 'acknowledged', 'baseline', 'muted')),
  first_seen_at timestamptz not null default now(),
  resolved_at timestamptz,
  unique (project_id, port)
);

create index if not exists port_findings_project_idx
  on public.port_findings(project_id, state);

alter table public.port_scans enable row level security;
alter table public.port_findings enable row level security;

-- Owner-scoped access, matching public.project_repos.
create policy "port_scans owner select" on public.port_scans for select
  using (project_id in (select id from public.projects where owner_id = auth.uid()));
create policy "port_scans owner insert" on public.port_scans for insert
  with check (project_id in (select id from public.projects where owner_id = auth.uid()));

create policy "port_findings owner select" on public.port_findings for select
  using (project_id in (select id from public.projects where owner_id = auth.uid()));
create policy "port_findings owner update" on public.port_findings for update
  using (project_id in (select id from public.projects where owner_id = auth.uid()));
