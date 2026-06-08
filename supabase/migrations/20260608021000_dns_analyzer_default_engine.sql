-- DNS Analyzer scan type — enabled by default on every property.
--
-- 'dns' is a free engine (cost 0 in lib/credits): it resolves a domain's full
-- DNS footprint and flags missing/weak/harmful records. We want it on by
-- default for all projects, so:
--   1) audits.engine accepts 'dns',
--   2) new projects get it in the column default, and
--   3) all existing projects are backfilled.
--
-- This must run after 20260608020000_engine_links.sql, which also rewrites
-- audits_engine_check.

alter table public.audits drop constraint if exists audits_engine_check;
alter table public.audits
  add constraint audits_engine_check
  check (engine in ('rule', 'spec', 'dns', 'links', 'claude', 'openai', 'gemini', 'qwen', 'kimi', 'deepseek', 'perplexity'));

alter table public.projects
  alter column engines set default array['rule', 'dns']::text[];

update public.projects
  set engines = engines || array['dns']::text[]
  where not ('dns' = any(engines));
