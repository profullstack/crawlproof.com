-- AEO Score time-series: one row per (project, scan_run) recording the
-- aggregate 0-100 score plus per-engine breakdown. Powers the trend chart
-- and the headline number on the project page. Owner-only via RLS; the
-- worker writes with the service role.

create table if not exists public.project_scores (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  scan_run_id uuid,
  -- Overall 0-100 score; matches audits.score range.
  score int not null check (score between 0 and 100),
  -- Per-engine component scores + any future signals (freshness, backlinks,
  -- tracker-derived AI referrals, etc.). Schema is forward-only — readers
  -- treat unknown keys as "not yet tracked".
  components jsonb not null default '{}'::jsonb,
  recorded_at timestamptz not null default now(),
  unique (project_id, scan_run_id)
);

create index if not exists project_scores_project_recorded_idx
  on public.project_scores(project_id, recorded_at desc);

alter table public.project_scores enable row level security;

create policy "project_scores owner select"
  on public.project_scores for select
  using (
    project_id in (select id from public.projects where owner_id = auth.uid())
  );
