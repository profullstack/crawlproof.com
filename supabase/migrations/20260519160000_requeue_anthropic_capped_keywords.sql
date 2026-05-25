-- One-shot recovery. On 2026-05-19 between ~13:00 and ~16:00 UTC the
-- Anthropic monthly spend cap was hit, and every in-flight article
-- generation caught the resulting 400 "specified API usage limits"
-- and marked its keyword 'failed' (see articleGen.ts catch block).
-- The Anthropic cap has since been raised. articleGen.ts now treats
-- this class of error as transient (keeps status='queued'), so this
-- migration's only job is to unstick the rows that were lost before
-- the code fix landed.
--
-- Scope: keywords with status='failed' updated in today's cap window.
-- Cross-site by design — the cap is an account-level signal, not a
-- per-tenant one.
UPDATE lx_keyword
   SET status = 'queued'
 WHERE status = 'failed'
   AND updated_at >= '2026-05-19T13:00:00Z'
   AND updated_at <= '2026-05-19T16:30:00Z';
