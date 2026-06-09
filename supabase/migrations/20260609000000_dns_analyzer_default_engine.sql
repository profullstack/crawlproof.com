-- DNS Analyzer scan type — enabled by default on every property.
--
-- 'dns' is a free engine (cost 0 in lib/credits): it resolves a domain's full
-- DNS footprint and has AI flag missing/weak/harmful records. We want it on by
-- default for all projects.
--
-- NOTE: renamed from a 20260608020000 prefix that collided with
-- 20260608020000_engine_links.sql (the linkinator engine), which would have
-- caused supabase to skip this migration.

-- 1) Allow 'dns' as an audit engine. The audits_engine_check whitelist was
--    last set by 20260608020000_engine_links.sql; re-add it including 'dns'
--    so inserting an audit row with engine='dns' doesn't violate the check.
alter table public.audits drop constraint if exists audits_engine_check;
alter table public.audits
  add constraint audits_engine_check
  check (engine in ('rule', 'spec', 'dns', 'links', 'claude', 'openai', 'gemini', 'qwen', 'kimi', 'deepseek', 'perplexity'));

-- 2) New projects default to the free engines (rule + dns).
alter table public.projects
  alter column engines set default array['rule', 'dns']::text[];

-- 3) Backfill: add 'dns' to every existing project that doesn't already have
--    it, preserving each project's current engine selection.
update public.projects
  set engines = engines || array['dns']::text[]
  where not ('dns' = any(engines));
