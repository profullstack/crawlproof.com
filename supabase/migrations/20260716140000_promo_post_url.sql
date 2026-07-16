-- Store the public permalink of each published post so the UI can link the
-- post history straight to the live post. The sweep already gets this as
-- PostResult.webUrl; external_post_id keeps only the opaque platform id.
alter table public.promo_post
  add column if not exists post_url text;
