-- Add specification.website MCP as a free scan engine.

alter table public.audits drop constraint if exists audits_engine_check;
alter table public.audits
  add constraint audits_engine_check
  check (engine in ('rule', 'spec', 'claude', 'openai', 'gemini', 'qwen', 'kimi', 'deepseek', 'perplexity'));
