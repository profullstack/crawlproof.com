-- Light/dark variants for ad creatives, and a per-slot default.
--
-- Every creative used to carry one palette, and the generator's prompt pushed
-- it dark. On a publisher page that is black-on-white — a plain blog with no
-- CSS of its own — the unit rendered as a hole punched in the page.
--
-- The existing bg/fg/accent trio keeps its meaning as the DARK palette. The
-- light_* trio is nullable: a creative without one still renders, because
-- paletteFor() derives a light palette from the dark one on the fly. The
-- backfill fills these in so the derivation is not paid for on every request.

alter table public.ad_creatives
  add column if not exists light_bg_color text,
  add column if not exists light_fg_color text,
  add column if not exists light_accent_color text;

comment on column public.ad_creatives.light_bg_color is
  'Background for light publisher pages. Null → derived from bg_color at render time.';
comment on column public.ad_creatives.light_fg_color is
  'Foreground for light publisher pages. Null → derived from fg_color at render time.';
comment on column public.ad_creatives.light_accent_color is
  'Accent/CTA for light publisher pages. Null → derived from accent_color at render time.';

-- Per-slot default polarity, used when the request cannot say what it found:
-- a MOTD fetched over curl, a feed spliced at build time, a page whose script
-- was blocked. 'auto' means "no opinion" and resolves to dark, which is what
-- every unit rendered as before this migration.
alter table public.ad_slots
  add column if not exists theme text not null default 'auto';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.ad_slots'::regclass and conname = 'ad_slots_theme_check'
  ) then
    alter table public.ad_slots
      add constraint ad_slots_theme_check check (theme in ('auto', 'light', 'dark'));
  end if;
end $$;

comment on column public.ad_slots.theme is
  'Default polarity for fills on this slot when the request does not specify one. Set by scripts/backfill-ad-themes.ts from the publisher site''s own background.';
