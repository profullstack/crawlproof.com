-- New-user welcome grant: 20 credits (= 1 free AI-model scan).
-- Supersedes the 60-credit default set in 20260607120000. Forward-only:
-- existing balances are untouched, only new signups get the new default.
alter table public.profiles
  alter column credits_balance set default 20;
