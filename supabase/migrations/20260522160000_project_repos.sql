-- Bind one or more GitHub repos to a Crawlproof project. Optional: a
-- project can have zero bound repos (the action modals fall back to
-- "browse all repos from my installations"). When bound repos exist, the
-- modals default to them so users don't have to filter through hundreds
-- of repos for every action.

create table if not exists public.project_repos (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  installation_id bigint not null,
  repo_owner text not null,
  repo_name text not null,
  default_branch text,
  added_by uuid references public.profiles(id) on delete set null,
  added_at timestamptz not null default now(),
  unique (project_id, repo_owner, repo_name)
);

create index if not exists project_repos_project_idx
  on public.project_repos(project_id);

alter table public.project_repos enable row level security;

create policy "project_repos owner select"
  on public.project_repos for select
  using (
    project_id in (select id from public.projects where owner_id = auth.uid())
  );

create policy "project_repos owner insert"
  on public.project_repos for insert
  with check (
    project_id in (select id from public.projects where owner_id = auth.uid())
  );

create policy "project_repos owner delete"
  on public.project_repos for delete
  using (
    project_id in (select id from public.projects where owner_id = auth.uid())
  );
