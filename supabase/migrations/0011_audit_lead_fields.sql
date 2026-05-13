-- Optional lead-qual fields collected from the hero/free-report form.
-- Phone is a free-text string (we don't normalize/validate here).
-- estimated_monthly_sales captures self-reported monthly revenue from
-- the user's website as a numeric so we can bucket/aggregate later.

alter table public.audits
  add column if not exists phone text,
  add column if not exists estimated_monthly_sales numeric;
