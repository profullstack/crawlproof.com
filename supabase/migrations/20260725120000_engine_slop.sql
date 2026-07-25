-- Add the Slop Score sweep (lib/audit/slop-engine.ts) as a free scan engine.
-- Without extending audits_engine_check, every 'slop' scan insert fails with
-- 'new row for relation "audits" violates check constraint
-- "audits_engine_check"' — the same trap the fugu and zai migrations document.

alter table public.audits drop constraint if exists audits_engine_check;
alter table public.audits
  add constraint audits_engine_check
  check (engine in ('rule', 'spec', 'dns', 'links', 'slop', 'vu1nz', 'claude', 'openai', 'gemini', 'qwen', 'kimi', 'deepseek', 'zai', 'perplexity', 'fugu'));
