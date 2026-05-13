-- Owner-initiated cancel for an in-flight audit. The worker checks
-- aborted_at IS NULL on every write so an abort can't be silently
-- overwritten by a late "complete" from a worker that was mid-API-call
-- when the user clicked Abort.

alter table public.audits
  add column if not exists aborted_at timestamptz;

create index if not exists audits_aborted_idx
  on public.audits(aborted_at)
  where aborted_at is not null;
