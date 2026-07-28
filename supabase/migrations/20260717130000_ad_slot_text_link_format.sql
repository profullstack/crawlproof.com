-- Allow the native text-link ad to serve on publisher slots.
--
-- ad_slots.formats gates which sizes serveAd() will fill for a slot, and its
-- original default predates the text_link format:
--   default array['banner_300x250','banner_728x90','banner_320x50']
-- So a publisher who copies the new text-link embed would get nothing back.
-- Widen the default for new slots and backfill existing ones so their
-- text-link embed actually fills.

alter table public.ad_slots
  alter column formats
  set default array['banner_300x250', 'banner_728x90', 'banner_320x50', 'text_link'];

update public.ad_slots
  set formats = array_append(formats, 'text_link')
  where not ('text_link' = any (formats));
