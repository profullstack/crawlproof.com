-- Extend the editorial profile so the LLM enrichment can populate
-- keyword targets, SEO metadata, tone, and competitor seeds. All
-- additive with safe defaults; existing rows keep working with
-- empty arrays / NULL strings until the user re-runs Fetch metadata.

alter table public.lx_site
  add column if not exists keywords        text[] not null default '{}',
  add column if not exists seo_title       text,
  add column if not exists seo_description text,
  add column if not exists tone            text,
  add column if not exists competitors     text[] not null default '{}';
