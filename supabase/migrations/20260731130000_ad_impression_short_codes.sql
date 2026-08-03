-- Short impression codes, so a paid terminal ad's click URL fits inside the
-- ASCII box.
--
-- A terminal ad prints its click URL as literal text inside a box the caller
-- sized. The old form, https://crawlproof.com/a/<uuid>, is 61 characters and
-- the narrowest supported box (44 cols) has 40 usable columns, so the URL was
-- always pushed outside the frame. A 12-character base62 code brings that to
-- 37 characters. See lib/ads/shortcode.ts for the width arithmetic.
--
-- Both columns are additive and nullable, and the application tolerates their
-- absence, so this migration is safe to apply before or after the deploy that
-- starts using them. Existing rows keep resolving through their UUID, which
-- /a/[id] still accepts — click URLs already printed into people's MOTDs and
-- SSH banners must not break.

alter table ad_impressions add column if not exists short_code text;

-- The publisher's surface tag (?src=bbs, ?src=ssh-banner, …). It used to ride
-- the printed click URL as "&s=<tag>", which cost up to 35 more columns in a
-- box that had none to give. Recording it on the impression instead means the
-- printed URL is just /a/<code>, and the click handler reads the tag back from
-- here. It also makes the tag queryable for per-surface reporting, which the
-- query-string form never was.
alter table ad_impressions add column if not exists src text;

-- Partial: only real codes are constrained, so the pre-existing rows (all
-- NULL) cost nothing and the index stays small.
create unique index if not exists ad_impressions_short_code_key
  on ad_impressions (short_code)
  where short_code is not null;
