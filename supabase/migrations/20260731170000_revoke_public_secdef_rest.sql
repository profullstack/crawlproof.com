-- Same PUBLIC-grant bug as 20260731160000, swept across the rest of the
-- SECURITY DEFINER functions in this database.
--
-- Recap: Postgres grants EXECUTE to PUBLIC by default on every new function.
-- "revoke ... from anon, authenticated" removes their explicit grants and
-- leaves PUBLIC's, which anon and authenticated inherit — so functions that
-- read as service-role-only were callable over /rest/v1/rpc/<name> by anyone
-- holding the publishable anon key.
--
-- The sharpest one here is consume_credit(p_owner, p_count). It is SECURITY
-- DEFINER and p_count is signed — lib/promote/reconcilePromo.ts calls it with a
-- negative count to refund. So any caller could run
-- consume_credit('<their own id>', -1000000) and mint themselves credits. Those
-- credits land in credits_balance without touching promo_credits, so the ad
-- network would treat them as CASH-BACKED and let them be withdrawn as USDC —
-- which walks straight through the solvency work in 20260731120000.
--
-- Every caller of every function below was traced first; all of them use the
-- service-role client, so nothing loses access:
--   * worker/index.ts builds its client from SUPABASE_SERVICE_ROLE_KEY, which
--     covers generateArticle -> consume/refund_article_*, generateGuestPost and
--     processDuePromoteLists/processBrowserPost -> consume_credit, and
--     articleGen -> lx_find_internal_links.
--   * The route handlers and server actions all use serviceClient():
--     credits-finalize + coinpay webhook, recent-outreach, scheduled-audits,
--     apply-fix, alerts, the outrank/crawlproof webhooks, and app/r/[token].
--   * get_public_findings has no caller at all; get_public_audit is invoked
--     with svc from a server component, never from the browser, so the public
--     share page keeps working.
--
-- Trigger and event-trigger functions are revoked outright: they only ever run
-- from their trigger, never over REST.

-- Privileged RPCs -> service role only.
revoke execute on function public.consume_credit(uuid,integer) from public, anon, authenticated;
grant  execute on function public.consume_credit(uuid,integer) to service_role;

revoke execute on function public.credit_purchase_complete(text,jsonb) from public, anon, authenticated;
grant  execute on function public.credit_purchase_complete(text,jsonb) to service_role;

revoke execute on function public.consume_article_generation(uuid,uuid) from public, anon, authenticated;
grant  execute on function public.consume_article_generation(uuid,uuid) to service_role;

revoke execute on function public.refund_article_entitlement(uuid,uuid) from public, anon, authenticated;
grant  execute on function public.refund_article_entitlement(uuid,uuid) to service_role;

revoke execute on function public.consume_alert_serp_budget(uuid,integer,integer) from public, anon, authenticated;
grant  execute on function public.consume_alert_serp_budget(uuid,integer,integer) to service_role;

revoke execute on function public.bump_autoblog_integration(uuid) from public, anon, authenticated;
grant  execute on function public.bump_autoblog_integration(uuid) to service_role;

revoke execute on function public.lx_find_internal_links(uuid,public.vector,integer,boolean) from public, anon, authenticated;
grant  execute on function public.lx_find_internal_links(uuid,public.vector,integer,boolean) to service_role;

revoke execute on function public.get_public_audit(text) from public, anon, authenticated;
grant  execute on function public.get_public_audit(text) to service_role;

revoke execute on function public.get_public_findings(text) from public, anon, authenticated;
grant  execute on function public.get_public_findings(text) to service_role;

-- Trigger / event-trigger functions: never reachable over REST.
revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.create_default_org_for_profile() from public, anon, authenticated;
revoke execute on function public.rls_auto_enable() from public, anon, authenticated;

-- DELIBERATELY NOT REVOKED: is_org_member, is_org_owner, is_org_wide_member,
-- is_project_editor, is_project_member, project_owner_id.
--
-- These are RLS helpers, called from inside 48 policies across 21 tables. A
-- policy expression is evaluated as the querying role, so that role needs
-- EXECUTE on anything the policy calls — revoking would not harden RLS, it
-- would break it. Every one of those 48 policies has polroles = '{0}' (PUBLIC),
-- so anon is in scope too and can't be revoked either.
--
-- What that leaves exposed is small and bounded: each takes explicit uuids and
-- returns a boolean, so a caller who already knows both a user id and an org or
-- project id can probe membership. No data is returned. Closing it means
-- rewriting the policies to inline the checks, which is a much larger and
-- riskier change than the leak justifies.
