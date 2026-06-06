-- Per-project Stats integrations. Users paste a third-party tracker script
-- or SDK snippet; CrawlProof fetches public scripts, statically maps public
-- endpoints / SDK calls, and stores the analysis for adapter work.

create table if not exists public.tracker_integrations (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  created_by uuid references public.profiles(id) on delete set null,
  name text not null,
  input text not null,
  source_url text,
  status text not null default 'ready' check (status in ('ready', 'error')),
  http_status int,
  content_type text,
  script_sha256 text,
  script_bytes int not null default 0,
  analysis jsonb not null default '{}'::jsonb,
  last_error text,
  fetched_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists tracker_integrations_project_created_idx
  on public.tracker_integrations(project_id, created_at desc);

create index if not exists tracker_integrations_project_source_idx
  on public.tracker_integrations(project_id, source_url);

alter table public.tracker_integrations enable row level security;

create policy "tracker_integrations owner all"
  on public.tracker_integrations for all
  using (
    project_id in (select id from public.projects where owner_id = auth.uid())
  )
  with check (
    project_id in (select id from public.projects where owner_id = auth.uid())
  );

create policy "tracker_integrations member select"
  on public.tracker_integrations for select
  using (public.is_project_member(project_id, auth.uid()));

create policy "tracker_integrations member insert"
  on public.tracker_integrations for insert
  with check (public.is_project_member(project_id, auth.uid()));

create policy "tracker_integrations member update"
  on public.tracker_integrations for update
  using (public.is_project_member(project_id, auth.uid()))
  with check (public.is_project_member(project_id, auth.uid()));

create policy "tracker_integrations member delete"
  on public.tracker_integrations for delete
  using (public.is_project_member(project_id, auth.uid()));

drop trigger if exists tracker_integrations_set_updated_at on public.tracker_integrations;
create trigger tracker_integrations_set_updated_at
  before update on public.tracker_integrations
  for each row execute function public.lx_set_updated_at();
