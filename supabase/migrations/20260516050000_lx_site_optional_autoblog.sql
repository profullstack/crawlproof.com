-- Decouple `lx_site` from autoblog enrollment.
--
-- Until now, lx_site doubled as "the user owns this domain" AND "this
-- domain is enrolled in autoblog + (optionally) backlink exchange",
-- because blog_root_url + sitemap_url were NOT NULL and the app-level
-- validation forced webhook_url to be set too. Result: a user who
-- wanted to scan a site without joining autoblog had no path to add
-- that site at all.
--
-- After this migration, an lx_site row can exist with just the domain
-- + url; the autoblog cron already filters `where webhook_url is not
-- null` (app/api/cron/lx-autoblog/route.ts), so scan-only sites are
-- naturally ignored by autoblog publishing.
--
-- No data backfill needed: existing rows all have these fields set
-- (they were required before).

alter table public.lx_site
  alter column blog_root_url drop not null;

alter table public.lx_site
  alter column sitemap_url drop not null;
