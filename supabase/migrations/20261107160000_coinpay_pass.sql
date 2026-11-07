-- Profullstack Pass (2026-11-07): a CoinPay user who deposits $99 into their
-- own CoinPay wallet gets a free month on every Profullstack property.
-- crawlproof is pay-as-you-go, so a pass pays the smallest credit pack once per
-- pass through grant_code_credits() (source 'coinpay-pass:<sub>:<expires_at>'),
-- which also adds promo_credits: pass credits are not cash-backed and never pay
-- a publisher.
--
-- coinpay_identities.pass_until: the pass expiry CoinPay reported at the last
-- sign-in (the claim is only seen then).
-- One grant per pass per CoinPay account, even when several crawlproof accounts
-- link the same sub: code_credit_grants' PK is (user_id, source), so the source
-- alone is made unique for pass grants. Additive only.

alter table public.coinpay_identities add column if not exists pass_until timestamptz;

create unique index if not exists code_credit_grants_one_coinpay_pass_idx
  on public.code_credit_grants (source)
  where source like 'coinpay-pass:%';
