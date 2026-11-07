-- `topic` is stemmed for matching ("midterm result"), which is no way to show a
-- subject to a person. The public /trending page shows this instead.
alter table public.ad_trend_topics add column if not exists label text;

-- The list from the old source: stale since 2026-09-12, and never subjects.
delete from public.ad_trend_topics where source = 'samebrain';
