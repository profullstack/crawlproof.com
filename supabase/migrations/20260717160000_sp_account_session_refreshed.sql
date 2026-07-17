-- Track when a cookie-auth account's browser session was last kept warm.
-- The worker's daily session-refresh sweep reloads each active cookie account
-- with its stored cookies and re-saves the rotated (sliding-expiry) cookies to
-- extend the session; this timestamp both gates the 24h cadence (so worker
-- restarts don't re-refresh a session that was just refreshed) and surfaces
-- "last refreshed" in the UI.
--
-- Apply via psql over the pooler / MCP (prod migration history diverged).
alter table public.sp_account
  add column if not exists session_refreshed_at timestamptz;
