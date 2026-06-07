-- Nickel-credit re-denomination + outreach credit charging.
--
-- Credits move from "1 credit = 1 scan = ~$1" to "1 credit ≈ $0.05". An
-- expensive AI action (scan / article / guest post / GitHub auto-fix) now
-- costs 20 credits (still ~$1 rack), while cheap actions (outreach) cost 1.
--
-- This migration keeps every existing wallet whole by multiplying balances
-- ×20, repoints the SQL-side hardcoded charge, fixes the signup grant, and
-- adds the per-message credit column outreach charging writes to.
--
-- NOTE: run-once migration. The ×20 multipliers below are NOT idempotent;
-- re-running would over-credit. Supabase tracks applied migrations, so this
-- is fine as a normal forward migration — do not replay it manually.

-- 1) Signup grant: 3 free scans → 3 × 20 credits.
alter table public.profiles
  alter column credits_balance set default 60;

-- 2) Re-denominate every existing wallet so its dollar value is unchanged.
update public.profiles
  set credits_balance = credits_balance * 20;

-- 3) Pending purchases were sized in old credits; bump so completion grants
--    the correct new-denomination amount. (Completed rows already landed in
--    the now-×20 balances above, so leave them as historical record.)
update public.credit_purchases
  set credits_added = credits_added * 20
  where status <> 'complete';

-- 4) Repoint the article-generation credit charge from 1 → 20 (= SCAN_CREDITS).
--    Entitlement branch is unchanged; only the credit-fallback branch scales.
create or replace function public.consume_article_generation(
  p_project uuid,
  p_owner uuid
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_entitlement uuid;
  v_profile uuid;
begin
  if not exists (
    select 1
    from public.projects p
    where p.id = p_project
      and p.owner_id = p_owner
  ) then
    return 'none';
  end if;

  update public.project_entitlements pe
  set articles_used = articles_used + 1
  where pe.id = (
    select pe2.id
    from public.project_entitlements pe2
    where pe2.project_id = p_project
      and now() >= pe2.period_start
      and now() < pe2.period_end
      and pe2.articles_used < pe2.articles_included
      and (
        pe2.subscription_id is null
        or exists (
          select 1
          from public.subscriptions s
          where s.id = pe2.subscription_id
            and s.user_id = p_owner
            and s.status = 'active'
            and now() >= s.current_period_start
            and now() < s.current_period_end
        )
      )
    order by pe2.period_start desc
    limit 1
  )
  returning pe.id into v_entitlement;

  if v_entitlement is not null then
    return 'entitlement';
  end if;

  update public.profiles
  set credits_balance = credits_balance - 20
  where id = p_owner
    and credits_balance >= 20
  returning id into v_profile;

  if v_profile is not null then
    return 'credit';
  end if;

  return 'none';
end;
$$;

grant execute on function public.consume_article_generation(uuid, uuid)
  to authenticated, service_role;

-- 5) Per-message credits charged for outreach (0 for free manual records).
alter table public.recent_outreach_messages
  add column if not exists credits_spent int not null default 0;
