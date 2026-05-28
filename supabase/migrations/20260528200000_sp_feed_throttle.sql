-- Per-platform delivery tracking for feed autoposts. Each item now
-- carries the set of platforms it has already been delivered to so the
-- worker can throttle each (user, platform) pair to one post per 4h
-- while still draining the backlog across other platforms in the same
-- sweep.

alter table public.sp_feed_item
  add column if not exists delivered_platforms text[] not null default '{}';

-- Backfill: items inserted as 'seen' under the immediate-post flow have
-- no delivery record, so flip them to 'ignored' to keep the new
-- throttle-aware drain loop from posting a backlog of stale URLs at
-- one-per-4h until eventually clean.
update public.sp_feed_item
  set status = 'ignored'
  where status = 'seen';
