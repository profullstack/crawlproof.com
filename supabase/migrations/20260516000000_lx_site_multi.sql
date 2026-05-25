-- Multi-site agency support — drop the v1 "one site per user"
-- constraint, add a human-readable name for the site picker.
-- See docs/agency-prd.md §2 for the full design.

-- 1. Lift the unique constraint. lx_site(domain) stays unique
-- (no domain can be enrolled twice across the network).
drop index if exists public.lx_site_user_unique;

-- 2. Human-readable name shown in the picker. Agencies often want
-- "Acme Client" instead of "acme-corp.com". Defaults to domain when
-- not set so existing rows + the no-config code path Just Work.
alter table public.lx_site
  add column if not exists name text;

update public.lx_site
  set name = domain
  where name is null;

-- 3. Non-unique index for "all sites for this user" lookups (the
-- agency dashboard + picker). Already implicitly satisfied by the
-- dropped unique index, but we want it explicit so the planner uses
-- it even after future schema changes.
create index if not exists lx_site_user_idx on public.lx_site(user_id);
