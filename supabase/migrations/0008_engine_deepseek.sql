-- Broaden audits.engine to include Gemini, Qwen, Kimi, DeepSeek.
-- (0007 only allowed rule/claude/openai.)

alter table public.audits drop constraint if exists audits_engine_check;
alter table public.audits
  add constraint audits_engine_check
  check (engine in ('rule', 'claude', 'openai', 'gemini', 'qwen', 'kimi', 'deepseek'));
