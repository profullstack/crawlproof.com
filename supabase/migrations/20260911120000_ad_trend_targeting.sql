-- Trending-topic targeting, and the 90-day promo that comes with it.
--
-- Apply ONE FILE AT A TIME via the Supabase MCP against ywcizjsgrcmhgyplldac
-- (prod's migration history has diverged from this directory, so `db push`
-- would replay files prod already has). Nothing here backfills a row that
-- serving reads, so applying it before or after the deploy is both safe: the
-- code treats a missing column as "no campaign is trending-targeted".
--
-- Three things:
--
--   1. ad_trend_topics — what another service says is trending right now.
--      Written by the ingestion job, read at serve time. One row per
--      (source, topic, window), replaced on each pull rather than appended,
--      because "what is trending" is a current fact and a month of history
--      would only ever be read as the latest row anyway.
--
--   2. ad_campaigns.trending_topics / topics — the advertiser's opt-in and the
--      subjects their campaign is about. Serving prefers a campaign whose
--      subjects are trending AND match the page it is filling.
--
--   3. ad_promos — the entitlement. An advertiser who turns trending targeting
--      on gets 90 days during which their clicks are metered exactly as usual
--      and billed at nothing.

-- ---------------------------------------------------------------- signals

create table if not exists public.ad_trend_topics (
  id uuid primary key default gen_random_uuid(),
  -- Where the signal came from. 'samebrain' is chovy.com's read on what
  -- founders are asking to build this week.
  source text not null default 'samebrain',
  topic text not null,
  -- How many distinct parties used the term in the window, and in the window
  -- before it. Kept alongside the score so a reader can tell a small rising
  -- subject from a large flat one without trusting our arithmetic.
  mentions integer not null default 0 check (mentions >= 0),
  prior_mentions integer not null default 0 check (prior_mentions >= 0),
  score numeric not null default 0 check (score >= 0),
  window_days integer not null default 7 check (window_days between 1 and 90),
  -- When the source generated this answer, and when we stored it. They differ
  -- by however long the pull was late, which is exactly the number that says
  -- whether a trend list is still worth targeting on.
  generated_at timestamptz,
  ingested_at timestamptz not null default now()
);

-- One row per topic per source per window: an ingest updates in place.
create unique index if not exists ad_trend_topics_key
  on public.ad_trend_topics(source, window_days, lower(topic));
create index if not exists ad_trend_topics_fresh
  on public.ad_trend_topics(source, window_days, score desc, ingested_at desc);

comment on table public.ad_trend_topics is
  'Current trending subjects from an external source (samebrain = chovy.com). Replaced on each ingest; not a history table.';

alter table public.ad_trend_topics enable row level security;

-- Readable by any signed-in account: these are subjects, not anybody's data,
-- and an advertiser choosing targeting needs to see what is trending. Writes
-- are the ingestion job's alone, which runs under the service role and is not
-- subject to RLS.
drop policy if exists "trend topics readable" on public.ad_trend_topics;
create policy "trend topics readable"
  on public.ad_trend_topics for select
  to authenticated
  using (true);

-- ------------------------------------------------------------- targeting

alter table public.ad_campaigns
  add column if not exists trending_topics boolean not null default false,
  add column if not exists topics text[] not null default '{}';

comment on column public.ad_campaigns.trending_topics is
  'Advertiser opted into trending-topic targeting: this campaign is preferred on pages whose subject is currently trending. Also what the 90-day premium promo is granted against.';
comment on column public.ad_campaigns.topics is
  'The subjects this campaign is about, normalised. Derived from the destination page when the campaign is created; editable by the owner.';

create index if not exists ad_campaigns_trending_idx
  on public.ad_campaigns(trending_topics)
  where trending_topics;

-- ----------------------------------------------------------------- promo

create table if not exists public.ad_promos (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  -- Null means the whole account. Today every grant names a campaign, because
  -- the entitlement is earned by turning trending targeting on for one.
  campaign_id uuid references public.ad_campaigns(id) on delete cascade,
  kind text not null default 'trending_premium_90'
    check (kind in ('trending_premium_90')),
  -- The rate this promo is a discount from, recorded rather than looked up:
  -- a promo that outlives a price change must still say what it was worth.
  -- 2 cents is the trending-premium CPC (lib/ads/pricing.ts).
  cpc_cents integer not null default 2 check (cpc_cents >= 0),
  starts_at timestamptz not null default now(),
  ends_at timestamptz not null,
  -- Set when somebody ends it early; a row is never deleted, because the
  -- billing question "was this click free?" has to stay answerable.
  revoked_at timestamptz,
  note text not null default '',
  created_at timestamptz not null default now()
);

-- One live promo per campaign. A second opt-in re-reads the first rather than
-- extending it: ninety days free is ninety days, not ninety per toggle.
create unique index if not exists ad_promos_campaign_kind
  on public.ad_promos(campaign_id, kind)
  where campaign_id is not null and revoked_at is null;
create index if not exists ad_promos_owner_idx on public.ad_promos(owner_id, ends_at desc);

comment on table public.ad_promos is
  'Billing entitlements. While one is live the campaign serves and meters exactly as usual and every click is charged zero — see resolveClick in lib/ads/serve.ts.';

alter table public.ad_promos enable row level security;

drop policy if exists "promos owner read" on public.ad_promos;
create policy "promos owner read"
  on public.ad_promos for select
  to authenticated
  using (auth.uid() = owner_id);
