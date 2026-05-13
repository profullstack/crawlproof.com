-- One summary email per multi-engine scan run instead of N per-engine PDFs.
-- We claim the right-to-send by atomically writing summary_email_sent_at on
-- the lexically-first audit row in the scan_run; concurrent workers lose
-- the race and skip the send.

alter table public.audits
  add column if not exists summary_email_sent_at timestamptz;

create index if not exists audits_scan_run_summary_idx
  on public.audits(scan_run_id)
  where summary_email_sent_at is not null;
