-- Master keywords, topic provenance, and the network opt-in.
--
-- Three columns, one root cause.
--
-- `seed_keywords` had become two lists wearing one name: the durable set of
-- subjects a blog is *about*, and the working set the research pipeline was
-- allowed to chew on. Nothing enforced a size on it, so it grew — ten entries
-- on coinpayportal — and the pipeline quietly truncated it twice on the way
-- through (`buildSeeds` to five, the DataForSEO loop to three). The seeds past
-- the cut had never produced a single keyword: thirty-two of them, across nine
-- sites. Splitting the durable list out under its own name and capping it is
-- what makes that class of bug impossible to reintroduce, because a list a
-- human can hold in their head is one the planner can afford to cover *all* of.
--
-- `master_keyword` on lx_keyword is the provenance the planner needs to do
-- that. Fair allocation across topics is not expressible without knowing which
-- topic each queued row came from, and inferring it after the fact by
-- substring-matching the keyword back to a seed is exactly the loose matching
-- that let "skye peptides" through the relevance gate in the first place.
--
-- `ads_enabled` is the network opt-in: house ads and partner guest posts in
-- published articles. Default true, because a network everybody has to be
-- asked to join is one that stays empty.

alter table public.lx_site
  add column if not exists master_keywords text[] not null default '{}',
  add column if not exists ads_enabled boolean not null default true;

comment on column public.lx_site.master_keywords is
  'The durable 3-12 subjects this blog covers. The keyword planner allocates its target evenly across ALL of these; nothing truncates it. Crossed with `modifiers` to stay anchored to the site''s own niche.';

comment on column public.lx_site.ads_enabled is
  'Opted into the CrawlProof network: house/partner ad units and guest posts are placed in published articles. Default true.';

-- A cap the planner can honour rather than a limit it has to work around.
-- Twelve is the point past which an even allocation of a 30-keyword target
-- stops giving each topic enough rows to be worth researching separately.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'lx_site_master_keywords_len'
  ) then
    alter table public.lx_site
      add constraint lx_site_master_keywords_len
      check (coalesce(array_length(master_keywords, 1), 0) <= 12);
  end if;
end $$;

-- Which master subject a queued keyword was researched for.
--
-- Nullable, and stays nullable: every row written before this migration has no
-- honest answer, and guessing one would corrupt the very coverage figures the
-- planner reads. Those rows are simply invisible to the fair-share maths, which
-- is the correct behaviour — they are already published or queued, so the
-- topics they belong to need no further filling on their account.
alter table public.lx_keyword
  add column if not exists master_keyword text;

comment on column public.lx_keyword.master_keyword is
  'The lx_site.master_keywords entry this keyword was researched for. Null on rows predating topic provenance; those are excluded from coverage rather than guessed at.';

create index if not exists lx_keyword_site_master_idx
  on public.lx_keyword (site_id, master_keyword);

-- Seed the durable list from what each site already had.
--
-- First ten only, mirroring the cap, and only where the column is still empty
-- so a re-run cannot stomp a hand-curated list. This is the one place the old
-- truncation is preserved on purpose: a site with more than ten seeds had no
-- coverage of the tail anyway, and the operator should choose which ten matter
-- rather than have position in an unordered array decide it.
update public.lx_site
set master_keywords = (
  select coalesce(array_agg(s order by ord), '{}')
  from (
    select s, ord from unnest(seed_keywords) with ordinality as t(s, ord)
    where length(trim(s)) > 0
    limit 10
  ) picked
)
where coalesce(array_length(master_keywords, 1), 0) = 0
  and coalesce(array_length(seed_keywords, 1), 0) > 0;
