-- The careers page installer records its runs in project_pr_runs like every
-- other PR-opening action. Widen the kind check to allow 'install_careers'.
alter table public.project_pr_runs
  drop constraint if exists project_pr_runs_kind_check;
alter table public.project_pr_runs
  add constraint project_pr_runs_kind_check
  check (kind in ('install_tracker', 'apply_fix', 'audience_hub', 'install_ad', 'install_careers'));
