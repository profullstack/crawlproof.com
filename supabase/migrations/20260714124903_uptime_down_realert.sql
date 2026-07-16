-- Re-alert reminders for still-down monitors. The worker resends the DOWN
-- email every UPTIME_REALERT_HOURS (default 6h) while a monitor stays down,
-- so a single missed alert doesn't leave an outage unnoticed. This column
-- tracks when the last down alert (initial or reminder) went out.
alter table public.monitors
  add column if not exists last_down_alert_at timestamptz;
