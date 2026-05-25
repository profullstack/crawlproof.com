-- Allow `marketing_contacts` to hold *leads* — email addresses captured
-- on the hero audit form for transactional / follow-up purposes —
-- separately from people who explicitly opted in to marketing.
--
-- Semantics post-migration:
--   consented_at IS NOT NULL  → explicit marketing opt-in (eligible
--                                for promo / newsletter sends)
--   consented_at IS NULL      → lead only (CAN-SPAM/GDPR: do NOT
--                                send marketing without separate consent;
--                                use only for transactional / sales follow-up
--                                the contact knowingly requested)
--
-- The audit hero form will now always upsert a lead row when an
-- email is provided (regardless of the marketing checkbox), so the
-- user has a list of every free-scan contact to follow up on.

alter table public.marketing_contacts
  alter column consented_at drop not null;

-- Make the default explicit-null instead of now() — we want inserts
-- without consented_at to land as leads, not as accidentally-consented
-- rows.
alter table public.marketing_contacts
  alter column consented_at drop default;
