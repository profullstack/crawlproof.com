-- One-shot backfill: strip target="..." and rel="..." from any anchor
-- in blog_posts.content_html whose href is an in-page fragment
-- (`#section-id`). The autoblog source briefly emitted TOC links
-- with target="_blank" so clicking a TOC entry opened a new tab;
-- the JS sanitizer in lib/markdown.ts handles new generations, this
-- cleans the rows that landed before that fix.
--
-- Plpgsql loop: each pass strips one attribute occurrence per anchor.
-- We re-run until UPDATE affects 0 rows so anchors carrying both
-- target= and rel= (or two of either) get both stripped.

do $$
declare
  v_affected integer;
begin
  loop
    update public.blog_posts
       set content_html = regexp_replace(
             content_html,
             '(<a\b[^>]*\bhref\s*=\s*(?:"#[^"]*"|''#[^'']*''|#[^\s>]+)[^>]*?)\s+target\s*=\s*(?:"[^"]*"|''[^'']*''|[^\s>]+)',
             E'\\1',
             'gi'
           ),
           updated_at = now()
     where content_html ~* '<a[^>]*\bhref\s*=\s*(?:"#[^"]*"|''#[^'']*''|#[^[:space:]>]+)[^>]*?\s+target\s*=';
    get diagnostics v_affected = row_count;
    exit when v_affected = 0;
  end loop;

  loop
    update public.blog_posts
       set content_html = regexp_replace(
             content_html,
             '(<a\b[^>]*\bhref\s*=\s*(?:"#[^"]*"|''#[^'']*''|#[^\s>]+)[^>]*?)\s+rel\s*=\s*(?:"[^"]*"|''[^'']*''|[^\s>]+)',
             E'\\1',
             'gi'
           ),
           updated_at = now()
     where content_html ~* '<a[^>]*\bhref\s*=\s*(?:"#[^"]*"|''#[^'']*''|#[^[:space:]>]+)[^>]*?\s+rel\s*=';
    get diagnostics v_affected = row_count;
    exit when v_affected = 0;
  end loop;
end $$;
