-- Fix circular RLS on all member access policies.
--
-- The previous member policies used inline EXISTS subqueries against
-- project_members, which itself has RLS. When evaluated from another
-- RLS-gated table (projects, tracker_*, audits, etc.) PostgreSQL enters
-- a recursive RLS evaluation loop that silently returns no rows —
-- causing 404s and empty data for members even when the membership row
-- exists.
--
-- Solution: a SECURITY DEFINER function that reads project_members
-- without RLS, breaking the loop. Identical pattern to project_owner_id().

create or replace function public.is_project_member(p_project_id uuid, p_user_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists(
    select 1 from public.project_members
    where project_id = p_project_id and user_id = p_user_id
  )
$$;

-- ── projects ────────────────────────────────────────────────────────────

drop policy if exists "projects member read"   on public.projects;
drop policy if exists "projects member update" on public.projects;

create policy "projects member read"
  on public.projects for select
  using (public.is_project_member(id, auth.uid()));

create policy "projects member update"
  on public.projects for update
  using  (public.is_project_member(id, auth.uid()))
  with check (public.is_project_member(id, auth.uid()));

-- ── audits ──────────────────────────────────────────────────────────────

drop policy if exists "audits member select" on public.audits;

create policy "audits member select"
  on public.audits for select
  using (
    project_id is not null
    and public.is_project_member(project_id, auth.uid())
  );

-- ── audit_findings ───────────────────────────────────────────────────────

drop policy if exists "findings via member project" on public.audit_findings;

create policy "findings via member project"
  on public.audit_findings for select
  using (
    exists(
      select 1 from public.audits a
      where a.id = audit_id
        and a.project_id is not null
        and public.is_project_member(a.project_id, auth.uid())
    )
  );

-- ── audit_artifacts ──────────────────────────────────────────────────────

drop policy if exists "artifacts via member project" on public.audit_artifacts;

create policy "artifacts via member project"
  on public.audit_artifacts for select
  using (
    exists(
      select 1 from public.audits a
      where a.id = audit_id
        and a.project_id is not null
        and public.is_project_member(a.project_id, auth.uid())
    )
  );

-- ── tracker_daily_stats ──────────────────────────────────────────────────

drop policy if exists "tracker_daily_stats member select" on public.tracker_daily_stats;

create policy "tracker_daily_stats member select"
  on public.tracker_daily_stats for select
  using (public.is_project_member(project_id, auth.uid()));

-- ── tracker_event_daily_stats ────────────────────────────────────────────

drop policy if exists "tracker_event_daily_stats member select" on public.tracker_event_daily_stats;

create policy "tracker_event_daily_stats member select"
  on public.tracker_event_daily_stats for select
  using (public.is_project_member(project_id, auth.uid()));

-- ── tracker_geo_daily_stats ──────────────────────────────────────────────

drop policy if exists "tracker_geo_daily_stats member select" on public.tracker_geo_daily_stats;

create policy "tracker_geo_daily_stats member select"
  on public.tracker_geo_daily_stats for select
  using (public.is_project_member(project_id, auth.uid()));

-- ── project_repos ────────────────────────────────────────────────────────

drop policy if exists "project_repos member select" on public.project_repos;
drop policy if exists "project_repos member insert" on public.project_repos;

create policy "project_repos member select"
  on public.project_repos for select
  using (public.is_project_member(project_id, auth.uid()));

create policy "project_repos member insert"
  on public.project_repos for insert
  with check (public.is_project_member(project_id, auth.uid()));

-- ── project_pr_runs ──────────────────────────────────────────────────────

drop policy if exists "project_pr_runs member select" on public.project_pr_runs;

create policy "project_pr_runs member select"
  on public.project_pr_runs for select
  using (public.is_project_member(project_id, auth.uid()));
