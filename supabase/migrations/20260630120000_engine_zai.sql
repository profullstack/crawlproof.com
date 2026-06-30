-- Add Z.AI (Zhipu GLM-4.6) as a paid OpenAI-compatible audit engine.
-- Mirrors the deepseek/qwen/kimi adapters (lib/audit/zai-engine.ts via
-- oa-compat-engine). The engine is wired in lib/credits.ts,
-- app/actions/runAudit.ts and worker/index.ts; this migration extends
-- audits_engine_check so 'zai' scans don't violate the constraint.

alter table public.audits drop constraint if exists audits_engine_check;
alter table public.audits
  add constraint audits_engine_check
  check (engine in ('rule', 'spec', 'dns', 'links', 'vu1nz', 'claude', 'openai', 'gemini', 'qwen', 'kimi', 'deepseek', 'zai', 'perplexity', 'fugu'));
