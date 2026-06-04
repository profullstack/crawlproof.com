-- sp_post was missing the `title` column. The browser-post migration
-- assumed it was added by the feed-autopost migration, but that migration
-- only added `title` to sp_feed_item, not sp_post.
alter table public.sp_post
  add column if not exists title text;
