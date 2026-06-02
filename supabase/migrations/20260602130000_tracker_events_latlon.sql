-- Add lat/lng to tracker_events for globe visualization.
alter table public.tracker_events
  add column if not exists lat  double precision,
  add column if not exists lng  double precision;
