-- Animated banner profiles for ad_video_assets.
--
-- The three IAB display sizes the static creatives already use, so a publisher
-- slot that takes the static banner takes the animated one with no layout
-- change. They ride on the existing video job rather than getting a pipeline of
-- their own: the same design snapshot produces the pre-roll and the banners, so
-- a campaign reads as one thing across both, and one render either succeeds or
-- fails as a unit.

alter table public.ad_video_assets
  drop constraint if exists ad_video_assets_profile_check;

alter table public.ad_video_assets
  add constraint ad_video_assets_profile_check
  check (profile = any (array[
    'master_1080p'::text,
    'mp4_720p'::text,
    'mp4_480p'::text,
    'hls'::text,
    'poster'::text,
    'captions'::text,
    'audio'::text,
    'gif_300x250'::text,
    'gif_728x90'::text,
    'gif_320x50'::text
  ]));
