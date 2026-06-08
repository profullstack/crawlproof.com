-- Add the recursive link-checker (linkinator) as a free scan engine.

alter table public.audits drop constraint if exists audits_engine_check;
alter table public.audits
  add constraint audits_engine_check
  check (engine in ('rule', 'spec', 'links', 'claude', 'openai', 'gemini', 'qwen', 'kimi', 'deepseek', 'perplexity'));
