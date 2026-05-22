-- Track every auto-PR Crawlproof opens on a customer repo. Used for
-- history UI, dedupe ("don't open a second tracker PR if one's already
-- open"), and refunds when a paid Apply Fix run fails after credit consume.

create table if not exists public.project_pr_runs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  owner_id uuid not null references public.profiles(id) on delete cascade,
  -- Which action.
  kind text not null check (kind in ('install_tracker', 'apply_fix')),
  -- Repo coordinates (we don't FK to a repos table — repos live on
  -- github.com, the installation scope is the source of truth).
  installation_id bigint not null,
  repo_owner text not null,
  repo_name text not null,
  default_branch text,
  -- Optional context for Apply Fix runs.
  audit_id uuid references public.audits(id) on delete set null,
  finding_key text,
  -- Lifecycle.
  status text not null default 'queued'
    check (status in ('queued', 'running', 'opened', 'noop', 'failed')),
  pr_url text,
  pr_number int,
  branch_name text,
  error text,
  -- Credit accounting (PR3 Apply Fix consumes 1; PR2 is free).
  credits_consumed int not null default 0,
  credits_refunded int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists project_pr_runs_project_idx
  on public.project_pr_runs(project_id, created_at desc);
create index if not exists project_pr_runs_dedupe_idx
  on public.project_pr_runs(project_id, kind, repo_owner, repo_name, status)
  where status in ('queued', 'running', 'opened');

alter table public.project_pr_runs enable row level security;

create policy "project_pr_runs owner select"
  on public.project_pr_runs for select
  using (auth.uid() = owner_id);
