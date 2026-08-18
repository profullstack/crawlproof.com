-- Feed ad format.
--
-- Adds `feed_item` — a creative served as a syndication item (RSS <item>, Atom
-- <entry>, JSON Feed item, or a bare HTML/Markdown/text body) from
-- /api/ads/feed, for splicing into a feed document a publisher generates. Four
-- parts, mirroring how terminal_ascii was introduced:
--   1. widen the creative format CHECK,
--   2. add the format to slot inventory (default + backfill) so serveAd() will
--      actually fill it,
--   3. backfill a feed creative for every existing campaign, derived from the
--      copy it already has — no LLM call, no advertiser action needed,
--   4. nothing else: the impression and click tables are format-agnostic, and a
--      feed fill meters through exactly the same path a banner does.
--
-- NOTE: prod migration history diverged — apply this single file via psql over
-- the pooler, do NOT `supabase db push`.

alter table public.ad_creatives drop constraint if exists ad_creatives_format_check;
alter table public.ad_creatives
  add constraint ad_creatives_format_check
  check (format in ('banner_300x250', 'banner_728x90', 'banner_320x50', 'text_link', 'terminal_ascii', 'feed_item'));

alter table public.ad_slots
  alter column formats
  set default array['banner_300x250', 'banner_728x90', 'banner_320x50', 'text_link', 'terminal_ascii', 'feed_item'];

update public.ad_slots
  set formats = array_append(formats, 'feed_item')
  where not ('feed_item' = any (formats));

-- Backfill: one feed creative per campaign that doesn't have one yet.
--
-- Copy is cloned from the campaign's best existing creative. text_link is
-- preferred first because it is the closest relative — a headline, one benefit
-- line and a CTA, designed to read as a single line rather than fill a box,
-- which is exactly what the default feed body is. terminal_ascii comes next for
-- the same reason, then the rectangle. banner_320x50 is last because it carries
-- the *shortened* mobile headline, and a feed item has no width problem that
-- would justify the truncated copy.
--
-- image_url is dropped: the default feed body is a single sponsored line and
-- never renders artwork, and carrying a banner URL would put it in the
-- `imageUrl` field of every as=fields payload, where a consumer templating its
-- own item would reasonably render it. logo_url is kept — style=card does use
-- it. Colours are kept because they drive the optional ANSI palette on
-- style=terminal and the campaign preview. The source creative's status is
-- carried over so a rejected campaign does not gain a servable creative.
insert into public.ad_creatives (
  campaign_id, owner_id, format, headline, body, cta_text,
  image_url, logo_url, bg_color, fg_color, accent_color, font_family,
  ai_provenance, status
)
select distinct on (c.campaign_id)
  c.campaign_id,
  c.owner_id,
  'feed_item',
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
    'source', 'backfill_feed_item',
    'from_creative', c.id,
    'from_format', c.format
  ),
  c.status
from public.ad_creatives c
where c.format <> 'feed_item'
  and not exists (
    select 1 from public.ad_creatives f
    where f.campaign_id = c.campaign_id and f.format = 'feed_item'
  )
order by
  c.campaign_id,
  case c.format
    when 'text_link' then 0
    when 'terminal_ascii' then 1
    when 'banner_300x250' then 2
    when 'banner_728x90' then 3
    else 4
  end,
  c.created_at;
