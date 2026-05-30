-- Autoblog hero/banner image style, per project (lx_site).
--
-- Until now every autoblog hero used one fixed art-direction block, so
-- every post across every project looked the same ("person at a screen").
-- This lets each project pick a banner style. All styles still anchor the
-- image on the POST's actual content (title + lede + tags + niche); they
-- only change the visual treatment.
--
--   editorial  — cinematic photojournalistic cover (the original look)
--   hype       — bold marketing / hype poster, energetic launch vibe
--   concept    — clean concept illustration of the post's core idea
--   tech       — sleek 3D / isometric render of the topic's objects/systems
--   bold_type  — striking minimal composition around the topic's key motif

alter table public.lx_site
  add column if not exists banner_style text not null default 'editorial'
    check (banner_style in ('editorial','hype','concept','tech','bold_type'));
