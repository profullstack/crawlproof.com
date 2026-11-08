-- Fleet crawler policy (lib/crawl/policy.ts): a slow or broken target
-- (timeout, DNS/TLS/connection error, HTTP 5xx) is flagged and left alone for
-- 30 days, then gets exactly one recheck. Success clears the flag; failure
-- flags it another 30 days.
--
-- promo_feed already has next_fetch_at / last_error; lx_feed_source parks with
-- status='given_up' + last_fetch_at. These two had nowhere to keep the flag.
-- Apply by hand, one file, in dev2 supabase-db (no `supabase db push`).

-- Social feed autopost: before this a dead feed was refetched every 15 minutes.
alter table public.sp_feed_config add column if not exists failed_at timestamptz;
alter table public.sp_feed_config add column if not exists next_check_at timestamptz;
comment on column public.sp_feed_config.next_check_at is
  'Set 30 days out when the feed timed out / was unreachable / 5xx; the poller skips it until then. Null = normal 15-minute cadence.';

-- Link-exchange sitemaps: an error was only ever text in sitemap_status and
-- nothing retried it.
alter table public.lx_site add column if not exists sitemap_failed_at timestamptz;
alter table public.lx_site add column if not exists sitemap_next_check_at timestamptz;
comment on column public.lx_site.sitemap_next_check_at is
  'When a failed sitemap crawl gets its one recheck (30 days after the failure). Null = nothing scheduled.';

create index if not exists lx_site_sitemap_recheck_idx
  on public.lx_site (sitemap_next_check_at)
  where sitemap_next_check_at is not null;

-- Sitemaps already sitting in an error state get their recheck 30 days after
-- the failure that put them there (immediately, if that is already past).
update public.lx_site
   set sitemap_failed_at = coalesce(last_sitemap_fetch_at, now()),
       sitemap_next_check_at = coalesce(last_sitemap_fetch_at, now()) + interval '30 days'
 where sitemap_status like 'error%'
   and sitemap_next_check_at is null;
