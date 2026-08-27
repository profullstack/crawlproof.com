-- Add the Repo Health engine, which scores the GitHub project behind a site.
-- Without extending audits_engine_check, every 'repo' scan insert fails with
-- a constraint violation before the worker ever sees the job.

alter table public.audits drop constraint if exists audits_engine_check;
alter table public.audits
  add constraint audits_engine_check
  check (engine in ('rule', 'spec', 'dns', 'links', 'slop', 'repo', 'vu1nz', 'claude', 'openai', 'gemini', 'qwen', 'kimi', 'deepseek', 'zai', 'perplexity', 'fugu'));
