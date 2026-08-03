-- Billing for the careers widget: JOB_POSTING_CREDITS is spent the first time
-- a posting goes open, and never again.
--
-- A separate migration rather than an edit to 20260803120000_careers_widget.sql
-- because that one is already merged and may have been applied — editing an
-- applied migration in place would leave the column silently missing.
--
-- Stamped rather than inferred from published_at so that closing and
-- re-opening a role is free (you buy the posting, not the month it is live),
-- and so a failed charge leaves an obvious null instead of a posting that went
-- live without being billed.
alter table public.job_postings
  add column if not exists credit_charged_at timestamptz;
