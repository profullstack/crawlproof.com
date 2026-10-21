-- Phone alerts for uptime monitors. When alert_phone is set the worker also
-- places a call through smshub (POST /api/v1/alerts, severity critical) when the
-- monitor goes DOWN and again when it RECOVERS. Reminders stay email-only.
-- smshub only rings the key owner's consented alert phone or their contacts,
-- so this is an operator setting, not a customer-facing one.
alter table public.monitors
  add column if not exists alert_phone text;
