-- Browser-automation posting support.
--
-- 1. sp_post gets a 'queued_browser' status for posts that need Playwright.
-- 2. sp_account gets image_style for cookie-auth accounts that need
--    AI-generated images (Instagram requires an image; others benefit from one).

alter table sp_post
  drop constraint if exists sp_post_status_check;

alter table sp_post
  add constraint sp_post_status_check
  check (status in ('queued','queued_browser','publishing','published','failed','cancelled'));

alter table sp_account
  add column if not exists image_style text not null default 'editorial'
  check (image_style in ('editorial','infographic','quote_card','diagram','screenshot','rotate','none'));

-- subreddit for browser-posted Reddit posts (title already exists from feed autopost migration).
alter table sp_post
  add column if not exists subreddit text;
