-- Drop the outbound tracker webhooks feature. SDK/CLI ingest reuses the
-- existing public /api/track endpoint with the project's site UUID, so
-- the fan-out table is dead weight.

drop table if exists public.tracker_webhooks;
