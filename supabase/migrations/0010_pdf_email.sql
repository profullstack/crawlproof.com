-- Anonymous / hero-form scans optionally collect an email so we can mail the
-- PDF report when the audit completes. Previously the email was only carried
-- in the HTTP enqueue body to the worker — if that POST failed and the 60s
-- sweep fallback picked the job up, the email was lost and no PDF went out.
-- Persisting it on the row makes the email survive every recovery path.

alter table public.audits
  add column if not exists pdf_email text;
