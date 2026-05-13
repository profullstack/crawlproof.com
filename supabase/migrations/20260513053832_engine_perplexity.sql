-- Broaden audits.engine to include Perplexity Sonar.
-- (0008 only allowed through deepseek.)

alter table public.audits drop constraint if exists audits_engine_check;
alter table public.audits
  add constraint audits_engine_check
  check (engine in ('rule', 'claude', 'openai', 'gemini', 'qwen', 'kimi', 'deepseek', 'perplexity'));
