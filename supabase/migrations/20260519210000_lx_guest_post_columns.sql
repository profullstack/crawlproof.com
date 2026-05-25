-- Guest-post columns on lx_article.
--
-- A guest post is an article AUTHORED by one site (author_site_id) that
-- is intended to be published on a DIFFERENT site (target_site_id) as
-- part of the link-exchange network. The article body contains a
-- contextual backlink to the author site.
--
-- Ownership convention:
--   - site_id stays the AUTHOR's site (so the author's dashboard counts
--     it, the author's credit was burned, the author owns the row).
--   - target_site_id marks the receiver. Delivery goes to that site's
--     webhook_url. NULL for normal own-blog posts.
--   - author_site_id = site_id for guest posts; NULL for normal posts.
--     Denormalized for query convenience.
--   - is_guest_post flips delivery + display behavior; required because
--     target_site_id may be NULL even on a guest-post row mid-generation.
alter table public.lx_article
  add column if not exists is_guest_post boolean not null default false,
  add column if not exists author_site_id uuid references public.lx_site(id) on delete set null,
  add column if not exists target_site_id uuid references public.lx_site(id) on delete set null;

create index if not exists lx_article_target_site_idx
  on public.lx_article(target_site_id)
  where target_site_id is not null;
create index if not exists lx_article_guest_post_idx
  on public.lx_article(author_site_id, created_at desc)
  where is_guest_post = true;
