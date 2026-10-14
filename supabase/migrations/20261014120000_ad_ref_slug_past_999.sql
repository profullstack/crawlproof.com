-- ref_slug was 'crawlproof-ad-' || lpad(seq::text, 3, '0'). lpad TRUNCATES a
-- longer string to the target length, so campaign 1000 became crawlproof-ad-100
-- and every insert after the 999th hit ad_campaigns_ref_slug_key. Pad to at
-- least three digits instead: 001..999 are unchanged, 1000+ keep every digit.
alter table public.ad_campaigns
  alter column ref_slug set expression as
    ('crawlproof-ad-' || lpad(seq::text, greatest(3, length(seq::text)), '0'));
