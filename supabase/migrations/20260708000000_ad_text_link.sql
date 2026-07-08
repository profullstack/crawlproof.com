-- Add the native "text_link" ad format to the creative CHECK constraint and
-- make it part of the default slot inventory. Existing slots are backfilled so
-- they can serve text links immediately.

alter table public.ad_creatives drop constraint if exists ad_creatives_format_check;
alter table public.ad_creatives
  add constraint ad_creatives_format_check
  check (format in ('banner_300x250', 'banner_728x90', 'banner_320x50', 'text_link'));

alter table public.ad_slots
  alter column formats
  set default array['banner_300x250', 'banner_728x90', 'banner_320x50', 'text_link'];

-- Backfill: append text_link to any existing slot that doesn't already list it.
update public.ad_slots
  set formats = array_append(formats, 'text_link')
  where not ('text_link' = any (formats));
