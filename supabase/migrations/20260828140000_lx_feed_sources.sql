-- The directory feeds the autoblog reads, and what happened last time.
--
-- Until now these were fetched live, inside article delivery, on a 3-second
-- timeout. That put a third-party HTTP call on the critical path of the one
-- operation a customer is paying for, and it made the whole source invisible:
-- when a topic feed went missing the block simply came back empty, and there
-- was nowhere to look. Both problems have the same fix — crawl on a schedule,
-- cache what came back, and keep the record of the attempt.
--
-- The source list is derived, never curated. Topics are the slugged
-- master_keywords of every active site, so a blog that adds a subject gets its
-- feed crawled on the next sweep with nobody filing a request. That is the
-- point: the operator sets subjects, and the feed list follows.

create table if not exists public.lx_feed_source (
  id uuid primary key default gen_random_uuid(),
  -- The directory's own topic slug. Unique because two sites covering the
  -- same subject must share one crawl rather than each causing their own.
  topic text not null unique,
  url text not null,
  -- active: crawl it. given_up: too many consecutive failures, left in place
  -- so the status page can still explain the absence rather than the row
  -- silently vanishing and the topic looking like it was never wanted.
  status text not null default 'active'
    check (status in ('active', 'given_up')),
  last_fetch_at timestamptz,
  last_success_at timestamptz,
  last_status integer,
  last_error text,
  item_count integer not null default 0,
  consecutive_failures integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.lx_feed_source is
  'RSS Amplifier topic feeds the autoblog cites from. Derived from active sites'' master_keywords by the worker''s feed sweep — not hand-curated.';

-- The sweep picks the least-recently-fetched active source, so this is the
-- index that decides throughput.
create index if not exists lx_feed_source_due_idx
  on public.lx_feed_source (status, last_fetch_at nulls first);

create table if not exists public.lx_feed_item (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references public.lx_feed_source(id) on delete cascade,
  title text not null,
  link text not null,
  first_seen_at timestamptz not null default now(),
  -- Link rather than guid: the link is what gets rendered, and it is the only
  -- field whose uniqueness actually prevents the same anchor appearing twice.
  unique (source_id, link)
);

comment on table public.lx_feed_item is
  'Cached posts from a topic feed. Read by the article delivery path so a third-party fetch is never on the critical path of publishing.';

create index if not exists lx_feed_item_source_seen_idx
  on public.lx_feed_item (source_id, first_seen_at desc);

-- Service-role only. Nothing here is user data and no browser reads it
-- directly; the status page goes through a server component holding the
-- service client. Enabling RLS with no policy is what makes that explicit
-- rather than incidental.
alter table public.lx_feed_source enable row level security;
alter table public.lx_feed_item enable row level security;
