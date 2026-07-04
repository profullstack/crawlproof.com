-- Failure diagnostics for browser-automated posts.
--
-- The compose UIs (tweet box, Reddit editor, etc.) only render for a live
-- authenticated session, so their selectors can't be verified without one.
-- When a browser post fails at a selector, the worker captures the real page
-- it was looking at — URL and (trimmed) HTML — so the actual authenticated DOM
-- can be inspected and the selectors fixed against ground truth. Overwritten by
-- the next attempt; only ever holds the most recent failure's page.

alter table public.sp_post
  add column if not exists debug_url text,
  add column if not exists debug_html text;
