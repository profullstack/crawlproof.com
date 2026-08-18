-- Give feed creatives their artwork back.
--
-- 20260818120000_ad_feed_item.sql deliberately dropped image_url when it
-- backfilled the feed creatives, on the reasoning that the default feed body is
-- a single sponsored line and would never render artwork.
--
-- That reasoning was right about the `text` style and wrong about the format.
-- A feed item sits between real blog posts, each of which has a title, a
-- picture and several paragraphs, and a bare line of text does not read as
-- restrained next to them — it reads as broken, and gets skipped. The `card`
-- style renders a banner, and rssamplifier.com now asks for it, so the column
-- has to carry the image the advertiser already has.
--
-- Source is the campaign's medium rectangle, which is the creative the hero
-- image was resolved for (see lib/ads/heroImage.ts) and the only format that
-- reliably has one: 96 of 106 campaigns. The other 10 stay null and render the
-- card without a picture, which is why the renderer treats the image as
-- optional rather than assuming it.
--
-- Only touches rows the backfill created and left null, so a creative whose
-- image was set by hand afterwards is not overwritten.
--
-- NOTE: prod migration history diverged — apply this single file via psql over
-- the pooler or the Supabase MCP, do NOT `supabase db push`.

update public.ad_creatives f
   set image_url = r.image_url
  from public.ad_creatives r
 where f.format = 'feed_item'
   and f.image_url is null
   and r.campaign_id = f.campaign_id
   and r.format = 'banner_300x250'
   and r.image_url is not null
   and f.ai_provenance ->> 'source' = 'backfill_feed_item';
