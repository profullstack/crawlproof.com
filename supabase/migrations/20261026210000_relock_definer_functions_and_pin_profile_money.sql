-- Re-lock SECURITY DEFINER functions, pin privileged profile columns, close payout writes.
--
-- 1. On the dev2 shared Postgres (supabase-db, database `postgres`), 44 SECURITY DEFINER
--    functions in public were executable by the public anon key on 2026-10-26, including
--    every money function: earn_transfer / earn_fund_pool / earn_award / earn_request_payout,
--    credit_purchase_complete, consume_credit, ad_charge_click, ad_paper_charge,
--    ad_apply_deposit_bonus, affiliate_request_payout, consume_article_generation,
--    refund_article_entitlement, ad_token_earnings(any owner). The repo already revoked
--    them (20260513063649, 20260731160000, 20260731170000, 20260906120000, ...), but the
--    ACLs did not survive the move to dev2, and several older revokes only said
--    `FROM public`, which never removes Supabase's explicit anon/authenticated grants.
--    This re-asserts the intended matrix idempotently. No function bodies change.
--
-- 2. profiles "self update" had no column restriction, so any signed-in user could PATCH
--    their own row: is_admin=true (then grant themselves credits from /admin),
--    credits_balance, promo_credits, ad_bonus_credits, plan, alert_serp_calls_used...
--    Every legitimate writer of those columns is the service role or a SECURITY DEFINER
--    function; the only user-session write is app/actions/settings.ts (display_name,
--    retain_raw_html, perf_report_cadence, timezone), which stays allowed.
--
-- 3. ad_payouts "own payouts" was FOR ALL: an owner could insert a negative payout (or flip
--    a sent payout to 'failed') to inflate slotAvailableCents and withdraw real crypto.
--    All payout writes go through lib/ads/payouts.ts with the service role, so owners keep
--    SELECT only.
--
-- 4. Two leftover *_bak_20261014 tables had RLS off with anon grants.
-- 5. New functions are no longer executable by PUBLIC or anon by default.

-- 1a. Server-only (service_role): money, internal, triggers.
DO $$
DECLARE
    fn text;
    sig text;
    names text[] := ARRAY[
        'ad_apply_deposit_bonus','ad_autobid_activity','ad_charge_click','ad_paper_charge',
        'ad_payout_solvency_guard','ad_stats_media_rollup_refresh','ad_stats_rollup_refresh',
        'ad_token_earnings','ad_video_funnel_for','ad_video_slot_funnel_for',
        'affiliate_fail_payout','affiliate_request_payout','bump_autoblog_integration',
        'consume_alert_serp_budget','consume_article_generation','consume_credit',
        'create_default_org_for_profile','credit_purchase_complete','earn_award',
        'earn_fail_payout','earn_fund_pool','earn_request_payout','earn_transfer',
        'email_tracking_on_project_insert','get_public_audit','get_public_findings',
        'handle_new_user','lx_find_internal_links','refund_article_entitlement',
        'rls_auto_enable','grant_code_credits'
    ];
BEGIN
    FOREACH fn IN ARRAY names LOOP
        FOR sig IN
            SELECT format('public.%I(%s)', p.proname, pg_get_function_identity_arguments(p.oid))
            FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public' AND p.proname = fn
        LOOP
            EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', sig);
            EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', sig);
        END LOOP;
    END LOOP;
END $$;

-- 1b. Signed-in dashboards: each derives the owner from auth.uid() itself.
DO $$
DECLARE
    fn text;
    sig text;
    names text[] := ARRAY[
        'ad_account_series','ad_campaign_bid_history','ad_campaign_daily_series',
        'ad_campaign_totals','ad_owner_media_split','ad_slot_daily_series','ad_slot_totals',
        'ad_video_funnel','ad_video_slot_funnel'
    ];
BEGIN
    FOREACH fn IN ARRAY names LOOP
        FOR sig IN
            SELECT format('public.%I(%s)', p.proname, pg_get_function_identity_arguments(p.oid))
            FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public' AND p.proname = fn
        LOOP
            EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', sig);
            EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', sig);
        END LOOP;
    END LOOP;
END $$;

-- Left callable on purpose:
--   public_job_postings(uuid): public careers board (anon by design, open postings only).
--   is_org_member / is_org_owner / is_org_wide_member / is_project_editor /
--   is_project_member / project_owner_id: RLS helpers used by 47 policies that apply TO
--   public; revoking them would turn anon reads into errors. Boolean/uuid oracles only.

-- 2. profiles: privileged columns are server-written only.
CREATE OR REPLACE FUNCTION public.profiles_pin_privileged_columns()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO ''
AS $function$
BEGIN
    -- SECURITY INVOKER on purpose: current_user is the PostgREST role for client writes,
    -- and the owner (postgres) inside SECURITY DEFINER functions such as ad_charge_click.
    IF current_user NOT IN ('authenticated', 'anon') THEN
        RETURN NEW;
    END IF;

    IF NEW.id                        IS DISTINCT FROM OLD.id
       OR NEW.email                     IS DISTINCT FROM OLD.email
       OR NEW.is_admin                  IS DISTINCT FROM OLD.is_admin
       OR NEW.plan                      IS DISTINCT FROM OLD.plan
       OR NEW.stripe_customer_id        IS DISTINCT FROM OLD.stripe_customer_id
       OR NEW.credits_balance           IS DISTINCT FROM OLD.credits_balance
       OR NEW.promo_credits             IS DISTINCT FROM OLD.promo_credits
       OR NEW.ad_bonus_credits          IS DISTINCT FROM OLD.ad_bonus_credits
       OR NEW.monthly_audit_count       IS DISTINCT FROM OLD.monthly_audit_count
       OR NEW.monthly_audit_reset_at    IS DISTINCT FROM OLD.monthly_audit_reset_at
       OR NEW.alert_serp_calls_used     IS DISTINCT FROM OLD.alert_serp_calls_used
       OR NEW.alert_serp_calls_reset_at IS DISTINCT FROM OLD.alert_serp_calls_reset_at
       OR NEW.perf_report_last_sent_at  IS DISTINCT FROM OLD.perf_report_last_sent_at
       OR NEW.default_org_id            IS DISTINCT FROM OLD.default_org_id
       OR NEW.created_at                IS DISTINCT FROM OLD.created_at
    THEN
        RAISE EXCEPTION 'profiles: id, email, is_admin, plan, credits, quotas and org are not client-writable'
            USING ERRCODE = '42501';
    END IF;

    RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.profiles_pin_privileged_columns() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS profiles_pin_privileged_columns ON public.profiles;
CREATE TRIGGER profiles_pin_privileged_columns
    BEFORE UPDATE ON public.profiles
    FOR EACH ROW EXECUTE FUNCTION public.profiles_pin_privileged_columns();

-- 3. ad_payouts: owners read their own; only the service role writes.
DROP POLICY IF EXISTS "own payouts" ON public.ad_payouts;
CREATE POLICY "own payouts" ON public.ad_payouts
    FOR SELECT USING (owner_id = auth.uid());

-- 4. Leftover backup tables.
ALTER TABLE IF EXISTS public.blog_posts_imghost_bak_20261014 ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.lx_article_imghost_bak_20261014 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.blog_posts_imghost_bak_20261014 FROM anon, authenticated;
REVOKE ALL ON TABLE public.lx_article_imghost_bak_20261014 FROM anon, authenticated;

-- 5. New functions: not executable by PUBLIC or anon unless granted on purpose.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM anon;

NOTIFY pgrst, 'reload schema';
