-- Rotating a display slot between media, without editing a publisher's site.
--
-- A slot names a SIZE and has never named a medium. That is what makes this a
-- server-side change: the ~54 properties carrying a CrawlProof unit pasted a div
-- with `data-format="banner_300x250"` on it, and none of them is going to be
-- edited again to opt into an animated or video unit. So serveAd picks the
-- medium per fill out of what the winning campaign has actually rendered, and
-- this migration adds the two columns that makes measurable and controllable.
--
-- Nothing here is required for serving. Both columns are read tolerantly (see
-- lib/ads/display-media.ts and the optional-insert retry in serveAd), so the
-- code can ship before the migration and the only cost is a reporting dimension
-- and a publisher preference that is not yet honoured.
--
-- NOTE: prod migration history diverged — apply this single file via psql over
-- the pooler, do NOT `supabase db push`.

-- 1. Which medium an impression was served as. --------------------------------
--
-- The entire return on rotating is being able to ask which medium a size
-- converts in. Without this column the feature is randomised delivery that
-- teaches nothing, so it is the load-bearing half of the change rather than
-- instrumentation bolted on after.
--
-- Nullable with no default on purpose: NULL means "served before rotation
-- existed", which is a different fact from 'static' and should not be
-- backfilled into one. Every row written from here on carries a value.
alter table public.ad_impressions
  add column if not exists media text;

alter table public.ad_impressions drop constraint if exists ad_impressions_media_check;
alter table public.ad_impressions
  add constraint ad_impressions_media_check
  check (media is null or media in ('static', 'image', 'gif', 'video', 'audio'));

-- The reporting read is "split one slot's delivery by medium over a window", so
-- the index leads with the slot and carries the timestamp.
create index if not exists ad_impressions_slot_media_idx
  on public.ad_impressions(slot_id, media, ts desc)
  where media is not null;

-- 2. A publisher's opt-out. ---------------------------------------------------
--
-- NULL (the default, and what every existing slot says) means rotate over
-- everything available — the behaviour this change is for. A non-empty array
-- narrows the rotation to the listed media, so a publisher who does not want
-- motion in their page sets array['static','image'] and a publisher who wants
-- only the animated unit can say so.
--
-- Not a single-value column: a slot that could name exactly one medium would
-- force a publisher who merely wants "no video" to also give up the hero image
-- and the animated banner. An allow-list is what the preference actually is.
--
-- Deliberately NOT added to serveAd's slot select. That select decides whether
-- any unit on any slot renders at all, and this repo applies migrations by hand,
-- so a deploy that lands ahead of the schema would take all display serving down
-- over a preference nobody has set. It is read in its own query where a failure
-- means "no preference stated".
alter table public.ad_slots
  add column if not exists media_mix text[];

alter table public.ad_slots drop constraint if exists ad_slots_media_mix_check;
alter table public.ad_slots
  add constraint ad_slots_media_mix_check
  check (
    media_mix is null
    or media_mix <@ array['static', 'image', 'gif', 'video', 'audio']::text[]
  );
