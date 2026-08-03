-- Ad network: actually lock the money RPCs down.
--
-- Phases 4-6 each ended with:
--
--   revoke execute on function public.ad_charge_click(...) from anon, authenticated;
--   grant  execute on function public.ad_charge_click(...) to service_role;
--
-- which reads as "only the service role can call this" and is not. Postgres
-- grants EXECUTE to PUBLIC by default on every new function, and anon /
-- authenticated inherit it. Revoking their *explicit* grants leaves the PUBLIC
-- one untouched, so the ACL stayed:
--
--   =X/postgres | postgres=X/postgres | service_role=X/postgres
--     ^^ the leading "=X" is PUBLIC — has_function_privilege('anon', …) = true
--
-- ad_charge_click is SECURITY DEFINER, so until this migration anyone holding
-- the publishable anon key could POST /rest/v1/rpc/ad_charge_click and:
--   * forge valid clicks against any funded campaign, draining its credits and
--     its daily budget at will, and
--   * accrue publisher earnings to a slot they own (the self-deal guard only
--     compares slot owner against campaign owner, and here they differ).
-- The ad_payouts solvency trigger capped the cash blast radius at lifetime
-- deposits, and no payout has ever been executed, so nothing was actually
-- withdrawn — but advertiser credits and every delivery metric were forgeable.
--
-- ad_apply_deposit_bonus was reachable the same way.
--
-- Revoking from PUBLIC is what actually removes it. Both callers
-- (lib/ads/serve.ts, lib/credits-finalize.ts) use the service-role client and
-- hold their own explicit grant, so nothing in the app loses access.
--
-- NOT applied to ad_account_series / ad_campaign_totals: those are SECURITY
-- INVOKER and scope every row to `owner_id = auth.uid()`, so an anon caller
-- gets an empty result rather than someone else's data. They need to stay
-- callable by authenticated.
--
-- Apply via psql over the pooler / MCP (prod history diverged), not `db push`.

revoke execute on function
  public.ad_charge_click(uuid,uuid,uuid,uuid,text,text,text,text,int,numeric)
  from public;

revoke execute on function public.ad_apply_deposit_bonus(text) from public;

-- Trigger functions have no business being callable over the REST surface at
-- all; this one only ever runs from the ad_payouts trigger.
revoke execute on function public.ad_payout_solvency_guard()
  from public, anon, authenticated;
