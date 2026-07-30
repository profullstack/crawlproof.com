-- Terminal (ASCII) ad format.
--
-- Adds `terminal_ascii` — a fixed-width ASCII box served as text/plain from
-- /api/ads/motd for shell MOTDs, SSH login banners, BBS screens, and CLI tools.
-- Three parts, mirroring how text_link was introduced:
--   1. widen the creative format CHECK,
--   2. add the format to slot inventory (default + backfill) so serveAd() will
--      actually fill it,
--   3. backfill a terminal creative for every existing campaign, derived from
--      the copy it already has — no LLM call, no advertiser action needed.
--
-- NOTE: prod migration history diverged — apply this single file via psql over
-- the pooler, do NOT `supabase db push`.

alter table public.ad_creatives drop constraint if exists ad_creatives_format_check;
alter table public.ad_creatives
  add constraint ad_creatives_format_check
  check (format in ('banner_300x250', 'banner_728x90', 'banner_320x50', 'text_link', 'terminal_ascii'));

alter table public.ad_slots
  alter column formats
  set default array['banner_300x250', 'banner_728x90', 'banner_320x50', 'text_link', 'terminal_ascii'];

update public.ad_slots
  set formats = array_append(formats, 'terminal_ascii')
  where not ('terminal_ascii' = any (formats));

-- Backfill: one terminal creative per campaign that doesn't have one yet.
--
-- Copy is cloned from the campaign's best existing creative — text_link and the
-- medium rectangle carry the full headline, while banner_320x50 holds the
-- shortened mobile variant, so they're preferred in that order. image_url is
-- dropped (a terminal has no artwork); colours are kept because they drive the
-- optional ANSI palette. The source creative's status is carried over so a
-- rejected campaign doesn't gain a servable creative.
insert into public.ad_creatives (
  campaign_id, owner_id, format, headline, body, cta_text,
  image_url, logo_url, bg_color, fg_color, accent_color, font_family,
  ai_provenance, status
)
select distinct on (c.campaign_id)
  c.campaign_id,
  c.owner_id,
  'terminal_ascii',
  c.headline,
  c.body,
  c.cta_text,
  null,
  c.logo_url,
  c.bg_color,
  c.fg_color,
  c.accent_color,
  c.font_family,
  jsonb_build_object(
    'source', 'backfill_terminal_ascii',
    'from_creative', c.id,
    'from_format', c.format
  ),
  c.status
from public.ad_creatives c
where c.format <> 'terminal_ascii'
  and not exists (
    select 1 from public.ad_creatives t
    where t.campaign_id = c.campaign_id and t.format = 'terminal_ascii'
  )
order by
  c.campaign_id,
  case c.format
    when 'text_link' then 0
    when 'banner_300x250' then 1
    when 'banner_728x90' then 2
    else 3
  end,
  c.created_at;
