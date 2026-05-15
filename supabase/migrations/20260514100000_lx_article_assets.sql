-- Link Exchange — autoblog article assets.
-- Adds the public storage bucket where featured images live and the
-- pgvector RPC used by the article generator to find internal-link
-- candidates by cosine similarity.

-- ============================================================
-- Public storage bucket for autoblog featured images
-- ============================================================
-- Public-read because customer blog renderers fetch the image without
-- auth. Path convention: '{site_id}/{slug}.webp'. Service-role writes
-- only; we do not allow user-side uploads.
insert into storage.buckets (id, name, public)
values ('lx-article-images', 'lx-article-images', true)
on conflict (id) do nothing;

-- ============================================================
-- lx_find_internal_links RPC
-- ============================================================
-- Returns up to p_limit pages from the caller's site ranked by cosine
-- similarity (lower distance = more similar). is_blog_post is the
-- internal-vs-blog flag; for v1 we want pillar/category pages (NOT blog
-- posts) to be the internal-link candidates. The caller specifies the
-- flag explicitly so future article-to-article linking can flip it.
--
-- security definer because callers come through the service role (worker)
-- and we want one canonical implementation that ignores RLS. The function
-- is locked down via REVOKE EXECUTE below so it's reachable from the
-- worker only.
create or replace function public.lx_find_internal_links(
  p_site_id uuid,
  p_query_embedding vector(1536),
  p_limit int default 3,
  p_is_blog_post boolean default false
)
returns table (
  id uuid,
  url text,
  title text,
  description text,
  distance float
)
language sql security definer set search_path = public stable as $$
  select
    p.id,
    p.url,
    p.title,
    p.description,
    (p.embedding <=> p_query_embedding) as distance
  from public.lx_site_page p
  where p.site_id = p_site_id
    and p.is_blog_post = p_is_blog_post
    and p.embedding is not null
  order by p.embedding <=> p_query_embedding
  limit greatest(0, least(p_limit, 20));
$$;

revoke execute on function public.lx_find_internal_links(uuid, vector(1536), int, boolean)
  from anon, authenticated;
