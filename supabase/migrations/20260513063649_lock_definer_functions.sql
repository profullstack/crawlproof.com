-- Lock down SECURITY DEFINER functions that should not be reachable via
-- the public REST API. The Supabase database linter flagged every one
-- of these because `anon` / `authenticated` had EXECUTE — meaning any
-- visitor could POST /rest/v1/rpc/<fn> and run it. They're all designed
-- to be invoked by the service role (worker, webhook) or by Postgres
-- itself (auth triggers), so revoke EXECUTE from the client roles.
--
-- Service role bypasses GRANT/REVOKE entirely, so worker + webhook
-- callers are unaffected.

revoke execute on function public.consume_credit(uuid, int)
  from anon, authenticated;

revoke execute on function public.credit_purchase_complete(text, jsonb)
  from anon, authenticated;

revoke execute on function public.handle_new_user()
  from anon, authenticated;

revoke execute on function public.rls_auto_enable()
  from anon, authenticated;

-- get_public_audit(text) and get_public_findings(text) intentionally
-- stay EXECUTE-able by anon. They are the read path for /r/<share_token>
-- public share links — the share token IS the access control (it's
-- 24 random bytes, unguessable). The functions never accept any input
-- other than the token and only return rows whose share_token matches.
-- Future linter runs will continue to flag them under
-- anon_security_definer_function_executable / 0028; that's expected
-- and intentional, not a regression.

-- public.marketing_contacts had RLS enabled with zero policies — that
-- denies everything to anon/authenticated implicitly (correct), but
-- the linter flags it as "you probably forgot to add a policy."
-- Writes happen exclusively via service role from
-- lib/marketing.ts::recordMarketingConsent. Add an explicit deny-all
-- so the intent is in code and the linter is happy.
create policy "marketing_contacts service-role only"
  on public.marketing_contacts
  for all
  to anon, authenticated
  using (false)
  with check (false);

