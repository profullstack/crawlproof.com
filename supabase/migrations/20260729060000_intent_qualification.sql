-- Qualify leads on intent, not just on resemblance.
--
-- The pipeline has been selecting for firmographics: a business that looks
-- like the kind of business you sell to. That is the cheap half of the
-- problem. The expensive half is that cold outreach to someone who has not
-- asked for anything converts badly however good the copy is, and no amount
-- of better targeting-by-resemblance changes it.
--
-- So a campaign can now require evidence that somebody actually asked, and
-- what they said is kept next to the lead rather than being thrown away after
-- the decision — a score with no visible reasoning is one nobody can correct.

alter table public.outreach_campaigns
  -- Null keeps the previous behaviour exactly: existing campaigns are not
  -- silently emptied by a feature they never opted into.
  add column if not exists min_intent integer,
  -- Which of the intent sources to sweep. Null means the defaults.
  add column if not exists intent_sources text[],
  -- How far back to look. A fortnight-old request has usually been answered.
  add column if not exists intent_recency text
    check (intent_recency is null or intent_recency in ('day', 'week', 'month'));

comment on column public.outreach_campaigns.min_intent is
  'Minimum intent score (0-100) a lead must show to be worked. Null disables intent qualification for this campaign.';

alter table public.outreach_prospects
  add column if not exists intent_score integer,
  add column if not exists intent_tier text,
  -- The sentence that earned the score. Kept because "why is this a lead"
  -- should be answerable without re-running anything.
  add column if not exists intent_reasons text[],
  add column if not exists intent_source text,
  add column if not exists intent_url text,
  -- When the person actually posted, which is the half of the signal that
  -- decays. Distinct from created_at, which is when we noticed.
  add column if not exists intent_posted_at timestamptz;

create index if not exists outreach_prospects_intent_idx
  on public.outreach_prospects (project_id, intent_score desc nulls last)
  where intent_score is not null;

comment on column public.outreach_prospects.intent_posted_at is
  'When the prospect publicly expressed intent. Distinct from created_at, which is when we found it — recency decays from this one.';

-- Public requests to buy, as their own record.
--
-- Not prospects. A prospect is a company with a domain you can email; an
-- intent signal is a person on a platform who said they want to buy
-- something. Filing the second as the first gives every Reddit thread the
-- target_key "reddit.com" and collapses the entire queue into one lead.
create table if not exists public.outreach_intent_signals (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  campaign_id uuid references public.outreach_campaigns(id) on delete set null,
  owner_id uuid not null references public.profiles(id) on delete cascade,

  source text not null,
  url text not null,
  title text,
  snippet text,

  score integer not null,
  tier text not null,
  reasons text[] not null default '{}',

  -- When they posted, which is what decays. Distinct from found_at.
  posted_at timestamptz,
  found_at timestamptz not null default now(),

  status text not null default 'new'
    check (status in ('new', 'working', 'replied', 'won', 'lost', 'dismissed')),
  notes text
);

-- The same thread found by two ticks is one signal.
create unique index if not exists outreach_intent_signals_url_idx
  on public.outreach_intent_signals (project_id, url);

-- The queue is always read strongest-first.
create index if not exists outreach_intent_signals_rank_idx
  on public.outreach_intent_signals (project_id, score desc, posted_at desc);

comment on table public.outreach_intent_signals is
  'Public expressions of buying intent, ranked by strength and recency. Distinct from prospects: the subject is a person on a platform, not a domain you can email.';
