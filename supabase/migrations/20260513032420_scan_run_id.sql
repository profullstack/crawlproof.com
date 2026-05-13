-- scan_run_id ties together the N audits that came from one "scan all
-- engines" click on the project page. The /projects/<id>/runs/<runId>
-- page joins on this column to show every engine side-by-side.

alter table public.audits
  add column if not exists scan_run_id uuid;

create index if not exists audits_scan_run_idx
  on public.audits(scan_run_id);

-- Backfill: group existing rows by (project_id, target_url) within a 30s
-- window of each other. Single-engine scans get their own scan_run_id too
-- so every audit row has one.
with grouped as (
  select
    id,
    coalesce(
      first_value(id) over (
        partition by project_id, target_url, owner_id, triggered_by, date_trunc('minute', created_at)
        order by created_at
      ),
      id
    ) as group_anchor
  from public.audits
  where scan_run_id is null
),
anchors as (
  select distinct group_anchor, gen_random_uuid() as run_id from grouped
)
update public.audits a
set scan_run_id = an.run_id
from grouped g
join anchors an on an.group_anchor = g.group_anchor
where a.id = g.id and a.scan_run_id is null;

-- After backfill, require the column on new inserts. Make it non-null so
-- runs/[runId] pages never have to handle orphans.
alter table public.audits
  alter column scan_run_id set default gen_random_uuid();
