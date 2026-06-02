-- Expand project_members access so team members can read all project data
-- and perform CRUD operations, not just project owners.
--
-- Affected tables:
--   projects              — member update (settings, engines, tracker toggle)
--   audits                — member select (view all audits in their project)
--   audit_findings        — member select (via project membership)
--   audit_artifacts       — member select (via project membership)
--   tracker_daily_stats   — member select
--   tracker_event_daily_stats — member select
--   tracker_geo_daily_stats   — member select
--   project_repos         — member select + insert
--   project_pr_runs       — member select

-- projects: members may update settings (engines, status, tracker toggle)
create policy "projects member update"
  on public.projects for update
  using  (exists(select 1 from public.project_members where project_id = id and user_id = auth.uid()))
  with check (exists(select 1 from public.project_members where project_id = id and user_id = auth.uid()));

-- audits: members can read all audits belonging to their project
create policy "audits member select"
  on public.audits for select
  using (
    project_id is not null and
    exists(select 1 from public.project_members where project_id = audits.project_id and user_id = auth.uid())
  );

-- audit_findings: members can read findings for audits in their project
create policy "findings via member project"
  on public.audit_findings for select
  using (
    exists(
      select 1 from public.audits a
      join public.project_members pm on pm.project_id = a.project_id
      where a.id = audit_id and pm.user_id = auth.uid()
    )
  );

-- audit_artifacts: members can read artifacts for audits in their project
create policy "artifacts via member project"
  on public.audit_artifacts for select
  using (
    exists(
      select 1 from public.audits a
      join public.project_members pm on pm.project_id = a.project_id
      where a.id = audit_id and pm.user_id = auth.uid()
    )
  );

-- tracker_daily_stats: members can view tracker stats for their project
create policy "tracker_daily_stats member select"
  on public.tracker_daily_stats for select
  using (
    exists(select 1 from public.project_members where project_id = tracker_daily_stats.project_id and user_id = auth.uid())
  );

-- tracker_event_daily_stats: members can view event stats for their project
create policy "tracker_event_daily_stats member select"
  on public.tracker_event_daily_stats for select
  using (
    exists(select 1 from public.project_members where project_id = tracker_event_daily_stats.project_id and user_id = auth.uid())
  );

-- tracker_geo_daily_stats: members can view geo stats for their project
create policy "tracker_geo_daily_stats member select"
  on public.tracker_geo_daily_stats for select
  using (
    exists(select 1 from public.project_members where project_id = tracker_geo_daily_stats.project_id and user_id = auth.uid())
  );

-- project_repos: members can view and add repos for their project
create policy "project_repos member select"
  on public.project_repos for select
  using (
    exists(select 1 from public.project_members where project_id = project_repos.project_id and user_id = auth.uid())
  );

create policy "project_repos member insert"
  on public.project_repos for insert
  with check (
    exists(select 1 from public.project_members where project_id = project_repos.project_id and user_id = auth.uid())
  );

-- project_pr_runs: members can view PR runs for their project
create policy "project_pr_runs member select"
  on public.project_pr_runs for select
  using (
    exists(select 1 from public.project_members where project_id = project_pr_runs.project_id and user_id = auth.uid())
  );
