-- Let a campaign say what it is pitching.
--
-- Campaigns were project-scoped in who they contacted but not in what they
-- said: the draft prompt hardcoded CrawlProof's site-audit offer, so a
-- campaign built to reach game studios about a 3D modelling role still sent
-- those studios an AEO audit pitch. The `angle` column only nudged emphasis
-- inside that fixed pitch; it could not replace the premise.
--
-- pitch_mode 'audit' keeps exactly the old behaviour and stays the default,
-- so existing campaigns are untouched.
--
-- pitch_facts is the honesty mechanism, not decoration. The audit pitch is
-- grounded in scan findings — every claim traces to something we measured.
-- A custom pitch has no scan to trace to, so the campaign declares the facts
-- the draft is allowed to state, and the same grounding guard runs against
-- those instead. Without it, a custom campaign would be a confident-
-- false-statement generator pointed at strangers.

alter table public.outreach_campaigns
  add column if not exists pitch_mode text not null default 'audit'
    check (pitch_mode in ('audit', 'custom')),
  -- Who is writing and why, in their own words.
  add column if not exists pitch_intro text,
  -- The single ask. Cold email gets one.
  add column if not exists pitch_ask text,
  -- Claims the draft may make, one per entry. The grounding guard treats
  -- anything outside this list as unsupported.
  add column if not exists pitch_facts jsonb not null default '[]'::jsonb,
  -- Scanning is the audit pitch's evidence-gathering step. A campaign that
  -- isn't selling an audit has no reason to scan the people it contacts, and
  -- scanning them anyway spends worker time and looks like surveillance.
  add column if not exists scan_prospects boolean not null default true;

comment on column public.outreach_campaigns.pitch_mode is
  'audit = pitch a CrawlProof scan, grounded in findings. custom = pitch whatever pitch_intro describes, grounded in pitch_facts.';

comment on column public.outreach_campaigns.pitch_facts is
  'Claims a custom draft is permitted to state. The grounding guard rejects drafts that assert anything else.';

comment on column public.outreach_campaigns.scan_prospects is
  'Whether discovered prospects get a free scan queued. Required for the audit pitch; off by default for custom campaigns.';

-- A custom pitch with nothing declared has nothing truthful to say, which is
-- the same bar the audit pitch already holds itself to.
alter table public.outreach_campaigns
  drop constraint if exists outreach_campaigns_custom_pitch_needs_intro;
alter table public.outreach_campaigns
  add constraint outreach_campaigns_custom_pitch_needs_intro
  check (pitch_mode <> 'custom' or (pitch_intro is not null and length(btrim(pitch_intro)) > 0));
