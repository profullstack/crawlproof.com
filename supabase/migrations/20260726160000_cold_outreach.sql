-- Cold outreach: prospects, a send log, and a do-not-contact list.
--
-- Three tables rather than one because they have three different lifetimes.
-- A prospect is working state you edit. A send is an immutable fact you
-- append. A suppression outlives both — it must survive deleting the
-- prospect, or "please never contact me again" is undone by a cleanup job.
--
-- Service-role only throughout. These rows are reached two ways — the MCP
-- server (which resolves the caller from a crp_ token) and the project Leads
-- tab (which calls requireProjectAccess) — and both scope every query by
-- project_id themselves. RLS is on with no policies, so a leaked anon key
-- reads nothing and a browser session cannot rewrite the send log.

-- ---------------------------------------------------------------- prospects

create table if not exists public.outreach_prospects (
  id uuid primary key default gen_random_uuid(),
  -- Leads belong to a project: "who are we pitching, on behalf of which
  -- site" is the question the whole pipeline answers, and the same agency
  -- runs different outreach for different clients. owner_id is kept
  -- alongside it because the daily send caps are per person, not per
  -- project — one operator with five projects still has one reputation.
  project_id uuid not null references public.projects(id) on delete cascade,
  owner_id uuid not null references public.profiles(id) on delete cascade,

  -- 'email' keys on the site's host; 'reddit' keys on the username.
  channel text not null check (channel in ('email', 'reddit')),
  -- Lower-cased host or reddit username. The dedupe key.
  target_key text not null,

  -- Email prospects: the site we scanned and who to write to.
  site_url text,
  contact_email text,
  contact_source text check (contact_source in ('mailto', 'text', 'manual')),

  -- Reddit prospects: the account and where we found them.
  reddit_username text,
  thread_id text,
  subreddit text,

  -- Evidence. A prospect with no report is not a prospect — every claim we
  -- make in a cold message has to trace back to one of these.
  audit_id uuid references public.audits(id) on delete set null,
  report_token text,
  score int,
  score_kind text check (score_kind in ('aeo', 'slop')),
  top_issues jsonb not null default '[]'::jsonb,
  quote_usd int,

  status text not null default 'new'
    check (status in ('new', 'researched', 'drafted', 'contacted', 'replied', 'won', 'lost', 'skipped')),
  notes text,

  -- Per-prospect one-click unsubscribe. Distinct from the marketing_contacts
  -- token: a cold recipient never joined that list, and putting them on it to
  -- give them an unsubscribe link would add them to the newsletter blast.
  unsubscribe_token text not null unique default encode(gen_random_bytes(16), 'hex'),

  last_sent_at timestamptz,
  last_step int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Plain columns, not lower(target_key): PostgREST's on_conflict can only
-- match an index over the columns themselves, and every writer normalises
-- target_key to lower case before inserting (normalizeHost / the reddit
-- username path both lower-case it).
--
-- Scoped to the project, not the owner: two projects may legitimately
-- pitch the same business, and merging them would let one client's
-- campaign consume the other's lead.
create unique index if not exists outreach_prospects_project_target_idx
  on public.outreach_prospects (project_id, channel, target_key);

create index if not exists outreach_prospects_status_idx
  on public.outreach_prospects (project_id, status, created_at desc);

create index if not exists outreach_prospects_owner_idx
  on public.outreach_prospects (owner_id, created_at desc);

alter table public.outreach_prospects enable row level security;

comment on table public.outreach_prospects is
  'Cold-outreach leads, scoped to a project. Reached through the MCP server '
  'and the project Leads tab, both via the service client after an access '
  'check.';

-- -------------------------------------------------------------------- sends

create table if not exists public.outreach_sends (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete set null,
  owner_id uuid not null references public.profiles(id) on delete cascade,
  prospect_id uuid references public.outreach_prospects(id) on delete set null,

  channel text not null check (channel in ('email', 'reddit_comment', 'reddit_dm')),
  campaign text not null,
  step int not null default 1 check (step between 1 and 3),

  -- Email address, or reddit username / thread id depending on channel.
  recipient text not null,
  subject text,
  body text not null,
  target_url text,

  provider text,
  provider_message_id text,
  -- Dry runs are logged too: seeing what WOULD have gone out, and to whom, is
  -- most of the value of a dry run.
  dry_run boolean not null default false,
  sent_at timestamptz not null default now()
);

-- The actual guard against contacting someone twice. The application check is
-- an optimisation; two concurrent agent calls would race straight past it.
-- Dry runs are excluded so rehearsing a send does not consume the slot.
create unique index if not exists outreach_sends_unique_live_idx
  on public.outreach_sends (owner_id, channel, campaign, lower(recipient), step)
  where dry_run = false;

create index if not exists outreach_sends_recent_idx
  on public.outreach_sends (owner_id, sent_at desc);

create index if not exists outreach_sends_project_idx
  on public.outreach_sends (project_id, sent_at desc);

create index if not exists outreach_sends_recipient_idx
  on public.outreach_sends (lower(recipient), sent_at desc);

alter table public.outreach_sends enable row level security;

comment on table public.outreach_sends is
  'Append-only log of cold outreach, including dry runs. The unique index is '
  'what actually prevents mailing the same person twice in a campaign step.';

-- ------------------------------------------------------------- suppressions

create table if not exists public.outreach_suppressions (
  id uuid primary key default gen_random_uuid(),
  -- 'email' one address, 'domain' everyone at a domain, 'reddit_user' one
  -- account. Domain scope matters: "take my company off your list" is one
  -- request, not one per mailbox.
  scope text not null check (scope in ('email', 'domain', 'reddit_user')),
  value text not null,
  reason text,
  -- Who asked. Null when it came from an unsubscribe click rather than an
  -- operator adding it by hand.
  added_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

-- Global, deliberately not per-owner: if someone asks CrawlProof to stop
-- contacting them, that applies to every CrawlProof user's outreach.
-- Plain columns for the same reason as above; addSuppression lower-cases
-- every value on the way in.
create unique index if not exists outreach_suppressions_scope_value_idx
  on public.outreach_suppressions (scope, value);

alter table public.outreach_suppressions enable row level security;

comment on table public.outreach_suppressions is
  'Global do-not-contact list for cold outreach. Global on purpose — an '
  'opt-out is a promise made by CrawlProof, not by one of its users.';

-- ------------------------------------------------------------------ touches

create or replace function public.outreach_prospects_touch_updated_at()
returns trigger language plpgsql set search_path = public as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists outreach_prospects_updated_at on public.outreach_prospects;
create trigger outreach_prospects_updated_at
  before update on public.outreach_prospects
  for each row execute function public.outreach_prospects_touch_updated_at();

-- ---------------------------------------------------------------- campaigns

-- A campaign is the thing that makes this automated rather than a set of
-- tools you drive by hand: it holds where leads come from, what to say, and
-- how fast. The cron tick (app/api/cron/outreach) walks active campaigns and
-- advances each prospect one stage.
--
-- auto_send defaults to FALSE on purpose. A new campaign discovers, scans,
-- researches and drafts on its own; sending stays off until someone reads a
-- few drafts and turns it on deliberately. The expensive mistake in cold
-- outreach is not a missed send, it is 400 bad sends from one warmed domain.

create table if not exists public.outreach_campaigns (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  owner_id uuid not null references public.profiles(id) on delete cascade,
  name text not null,
  channel text not null default 'email' check (channel in ('email', 'reddit')),
  active boolean not null default false,

  -- Email discovery sources.
  queries jsonb not null default '[]'::jsonb,      -- SERP queries
  seed_urls jsonb not null default '[]'::jsonb,    -- directories / listicles

  -- Reddit discovery.
  keywords jsonb not null default '[]'::jsonb,
  subreddits jsonb not null default '[]'::jsonb,
  negative_keywords jsonb not null default '[]'::jsonb,

  -- Only pitch sites weak enough for the pitch to be true.
  max_score int not null default 70,
  -- Per-campaign throttle, additionally clamped by the global env cap.
  daily_send_limit int not null default 10,
  -- How many prospects to keep in the funnel before discovering more.
  target_pipeline int not null default 25,

  auto_send boolean not null default false,
  follow_ups boolean not null default true,

  angle text,
  sender_name text,
  reply_to text,

  last_run_at timestamptz,
  last_run_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Plain columns so the campaign tool can upsert on (project_id, name). The
-- cost is that "Dentists" and "dentists" would be two campaigns; lookups use
-- ilike, so the second one would be ambiguous rather than silently merged.
create unique index if not exists outreach_campaigns_project_name_idx
  on public.outreach_campaigns (project_id, name);

create index if not exists outreach_campaigns_active_idx
  on public.outreach_campaigns (active, last_run_at);

alter table public.outreach_campaigns enable row level security;

comment on table public.outreach_campaigns is
  'Automated cold-outreach campaigns. auto_send defaults false: a campaign '
  'builds and drafts on its own, but only sends once explicitly enabled.';

drop trigger if exists outreach_campaigns_updated_at on public.outreach_campaigns;
create trigger outreach_campaigns_updated_at
  before update on public.outreach_campaigns
  for each row execute function public.outreach_prospects_touch_updated_at();

-- Which campaign a lead came from, so a paused campaign stops advancing its
-- own leads without touching anyone else's.
alter table public.outreach_prospects
  add column if not exists campaign_id uuid references public.outreach_campaigns(id) on delete set null;

alter table public.outreach_prospects
  add column if not exists discovered_via text;

alter table public.outreach_prospects
  add column if not exists discovery_label text;

create index if not exists outreach_prospects_campaign_idx
  on public.outreach_prospects (campaign_id, status);

-- No RLS policies anywhere in this migration. The Leads tab and the MCP
-- tools both read through the service client after checking project access
-- (requireProjectAccess), which is how the rest of the project pages already
-- work — and it keeps outreach_sends unwritable from a browser, so the
-- record of what was sent to whom cannot be edited after the fact.
