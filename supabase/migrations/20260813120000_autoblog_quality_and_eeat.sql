-- Autoblog quality gate + E-E-A-T delivery fields.
--
-- Two independent additions that ship together because both touch the
-- generate → deliver path:
--
-- 1. lx_article.slop_score / slop_issues — the verdict from the pre-publish
--    gate (lib/lx/qualityGate.ts). Recorded on every accepted draft so a
--    site's content quality is a trend, not just a pass/fail at write time.
--
-- 2. lx_site.author_name / author_url — the byline shipped with each post.
--    crawlproof's own audit penalises sites for missing author attribution
--    and Person markup (lib/audit/checks/content.ts "content.author"), while
--    the autoblog was delivering posts with author: null. These columns let
--    the webhook payload carry a real byline so receivers can render one.

alter table public.lx_article
  add column if not exists slop_score smallint,
  add column if not exists slop_issues jsonb not null default '[]'::jsonb,
  -- dateModified for Article/BlogPosting markup on the receiver. Distinct
  -- from created_at: a regenerated or edited post keeps its original
  -- published_at while updated_at moves.
  add column if not exists updated_at timestamptz not null default now();

comment on column public.lx_article.slop_score is
  'Slop score 0-100 from the pre-publish quality gate. Lower is better; see lib/lx/qualityGate.ts.';
comment on column public.lx_article.slop_issues is
  'SlopIssue[] recorded at generation time. Evidence for the score.';

-- Trend query support: "show me this site''s recent quality".
create index if not exists lx_article_site_slop_idx
  on public.lx_article(site_id, created_at desc)
  where slop_score is not null;

alter table public.lx_site
  add column if not exists author_name text,
  add column if not exists author_url text;

comment on column public.lx_site.author_name is
  'Byline shipped with each delivered post. Null means no author is asserted.';
comment on column public.lx_site.author_url is
  'Author profile URL for the byline, used as schema.org Person.url / sameAs.';
