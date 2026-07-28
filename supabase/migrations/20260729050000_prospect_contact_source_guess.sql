-- Let a prospect record how its address was actually found.
--
-- contact_source was constrained to ('mailto','text','manual') when the only
-- ways to find an address were reading a link, reading page text, or being
-- told. Two more have been added since — a search fallback and, last of all, a
-- guessed role address — and neither could be written down.
--
-- The failure was total rather than cosmetic: the whole prospect row was
-- rejected by the check, so a business whose address had to be guessed was
-- discovered, crawled, searched for and then dropped on the floor with a
-- constraint error in the run log. builtinla.com is in that log twice.
--
-- 'guess' matters most of the four to keep distinguishable. A constructed
-- address bounces far more often than a published one, and bounces are
-- charged to the sender's reputation — so "we made this up" has to survive
-- into the record where the send path can still see it.

alter table public.outreach_prospects
  drop constraint if exists outreach_prospects_contact_source_check;

alter table public.outreach_prospects
  add constraint outreach_prospects_contact_source_check
  check (contact_source = any (array['mailto', 'text', 'manual', 'search', 'guess', 'page', 'json-ld']));

comment on column public.outreach_prospects.contact_source is
  'How the address was found. guess = constructed role address, never published; it bounces more often and the send path treats it accordingly.';
