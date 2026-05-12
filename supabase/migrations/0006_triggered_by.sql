-- Distinguish manual scans (hero form, project-page Run button) from
-- scheduled re-runs. Manual scans get a free 10/day-per-URL quota for
-- signed-in users; scheduled runs always spend 1 credit.

alter table public.audits
  add column if not exists triggered_by text not null default 'manual'
  check (triggered_by in ('manual', 'scheduled'));

create index if not exists audits_quota_idx
  on public.audits(owner_id, target_url, triggered_by, created_at desc);
