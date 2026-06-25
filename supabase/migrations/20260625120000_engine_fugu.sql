-- Add Sakana Fugu as a paid OpenAI-compatible audit engine.
-- The engine landed in code (lib/credits.ts, app/actions/runAudit.ts,
-- worker/index.ts) but no migration extended audits_engine_check, so any scan
-- that ran 'fugu' failed with "new row for relation \"audits\" violates check
-- constraint \"audits_engine_check\"".

alter table public.audits drop constraint if exists audits_engine_check;
alter table public.audits
  add constraint audits_engine_check
  check (engine in ('rule', 'spec', 'dns', 'links', 'vu1nz', 'claude', 'openai', 'gemini', 'qwen', 'kimi', 'deepseek', 'perplexity', 'fugu'));
