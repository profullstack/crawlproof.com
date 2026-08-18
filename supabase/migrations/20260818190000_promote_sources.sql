-- Promote content sources: campaigns that feed themselves.
--
-- Until now a Promote list was a hand-pasted set of links. The user typed 20
-- URLs and the drip engine rotated through them forever. That works for a fixed
-- set of product pages and nothing else: it cannot promote what the user
-- published this morning, and it gives a user with no back catalogue nothing to
-- post at all.
--
-- A *source* is a standing subscription that keeps supplying links:
--
--   rssamplifier_topic  a keyword. "bitcoin" becomes the RSS Amplifier topic
--                       feed https://rssamplifier.com/topics/bitcoin.rss.
--                       One keyword is one source — several keywords never
--                       collapse into a single ambiguous URL.
--   custom_feed         any RSS or Atom URL the user owns or follows.
--   manual_url          the existing hand-pasted behaviour, now named.
--
-- Three tables, because the fetch and the subscription are different things:
--
--   promo_feed       one row per feed URL, shared by every list that subscribes
--                    to it. Two hundred users tracking "bitcoin" poll RSS
--                    Amplifier once between them, not two hundred times. This
--                    is the whole reason the registry is keyed on the URL and
--                    carries no user_id.
--   promo_feed_item  the normalized entries of a feed, also shared. Fetched
--                    once, then fanned out by reference.
--   promo_source     one list's subscription to one feed, with the ownership
--                    classification that drives blend ratios.
--
-- Items still land in promo_link, which stays the unit the drip engine rotates
-- through. A source-fed link is a promo_link with source_id set; a hand-pasted
-- one has source_id null. Nothing about the existing engine changes shape.

-- ---------- promo_feed: the shared fetch registry ----------
create table if not exists public.promo_feed (
  id uuid primary key default gen_random_uuid(),

  -- The identity of the registry. One row per feed, globally.
  feed_url text not null unique,

  kind text not null default 'custom_feed'
    check (kind in ('rssamplifier_topic', 'custom_feed', 'project_feed')),

  -- Set for rssamplifier_topic feeds: the topic slug the URL was built from.
  topic_slug text,

  -- The feed's own <title>, used to attribute shared content.
  title text,

  -- Conditional-request state, so a feed that has not changed costs us a 304
  -- rather than a parse.
  etag text,
  last_modified text,

  -- Scheduler bookkeeping. next_fetch_at is the claim point.
  fetch_interval_seconds int not null default 900
    check (fetch_interval_seconds between 300 and 86400),
  next_fetch_at timestamptz not null default now(),
  last_fetched_at timestamptz,
  last_success_at timestamptz,

  -- A feed that keeps failing backs off and eventually stops being polled;
  -- the sources that subscribe to it surface the error.
  consecutive_failures int not null default 0,
  last_error text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The claim query: due feeds, oldest first.
create index if not exists promo_feed_due_idx
  on public.promo_feed (next_fetch_at);

-- ---------- promo_feed_item: normalized entries, fetched once ----------
create table if not exists public.promo_feed_item (
  id uuid primary key default gen_random_uuid(),
  feed_id uuid not null references public.promo_feed(id) on delete cascade,

  -- url is what we publish; normalized_url and url_hash are dedupe identity
  -- only (scheme folded, www dropped, tracking parameters removed). They are
  -- deliberately different values — see lib/promote/normalizeUrl.ts.
  url text not null,
  normalized_url text not null,
  url_hash text not null,

  title text,
  summary text,
  image_url text,
  author_name text,

  -- The originating publication. Aggregator feeds name it in <source>, which
  -- is what shared content gets attributed to.
  source_name text,

  -- The publisher's own id for the entry, when it gives one.
  guid text,

  published_at timestamptz,
  discovered_at timestamptz not null default now(),

  -- One entry per feed. The hash, not the raw URL, so a publisher re-emitting
  -- the same story with a fresh campaign tag does not create a second item.
  unique (feed_id, url_hash)
);

create index if not exists promo_feed_item_feed_recent_idx
  on public.promo_feed_item (feed_id, published_at desc nulls last);

-- ---------- promo_source: a list's subscription ----------
create table if not exists public.promo_source (
  id uuid primary key default gen_random_uuid(),
  list_id uuid not null references public.promo_list(id) on delete cascade,

  -- Null for manual_url sources, which have no feed behind them.
  feed_id uuid references public.promo_feed(id) on delete cascade,

  type text not null
    check (type in ('rssamplifier_topic', 'custom_feed', 'manual_url', 'project_feed')),

  -- Drives blend ratios, attribution and fallback. Keyword sources default to
  -- 'shared' because the content belongs to somebody else.
  ownership text not null default 'shared'
    check (ownership in ('owned', 'partner', 'shared')),

  -- What the user typed: the keyword, or a name for the feed.
  label text not null,

  -- The display form of the keyword for topic sources ("Artificial
  -- Intelligence"); promo_feed.topic_slug holds the normalized form.
  keyword text,

  enabled boolean not null default true,

  -- Ceiling on how many new links one ingestion pass may import from this
  -- source, so a feed with a 500-entry backlog cannot flood a list.
  max_items_per_ingest int not null default 10
    check (max_items_per_ingest between 1 and 100),

  last_ingested_at timestamptz,
  items_imported int not null default 0,

  created_at timestamptz not null default now(),

  -- A list subscribes to a given feed once.
  unique (list_id, feed_id)
);

create index if not exists promo_source_list_idx
  on public.promo_source (list_id, enabled);
create index if not exists promo_source_feed_idx
  on public.promo_source (feed_id, enabled);

-- ---------- promo_link: provenance for source-fed links ----------
alter table public.promo_link
  add column if not exists source_id uuid references public.promo_source(id) on delete set null,
  add column if not exists ownership text not null default 'owned'
    check (ownership in ('owned', 'partner', 'shared')),
  add column if not exists summary text,
  add column if not exists image_url text,
  add column if not exists author_name text,
  add column if not exists source_name text,
  add column if not exists normalized_url text,
  add column if not exists url_hash text,
  add column if not exists published_at timestamptz,
  add column if not exists discovered_at timestamptz not null default now();

-- Hand-pasted links predate sources and are the user's own: 'owned' is the
-- right default for them, which is why the column defaults that way rather
-- than to 'shared'.

-- Dedupe on identity as well as on the raw URL. Partial, because links that
-- predate this migration have no hash and must not collide with each other.
create unique index if not exists promo_link_list_hash_idx
  on public.promo_link (list_id, url_hash)
  where url_hash is not null;

create index if not exists promo_link_source_idx
  on public.promo_link (source_id);

-- Selection reads "enabled links of this list by ownership, least recently
-- promoted first" on every tick.
create index if not exists promo_link_blend_idx
  on public.promo_link (list_id, enabled, ownership, last_promoted_at);

-- ---------- promo_post: what the blend actually did ----------
-- Ownership is denormalized onto the post the same way platform already is,
-- because the selector reads "what have I posted lately" on every tick and
-- must not join back through promo_link — a link can be deleted, and the
-- history of the ratio has to survive that.
alter table public.promo_post
  add column if not exists ownership text,
  add column if not exists source_id uuid references public.promo_source(id) on delete set null,
  -- True when the blend could not honour its target and drew from the other
  -- side instead. Counted against fallback_policy.maxFallbackItemsPerDay.
  add column if not exists via_fallback boolean not null default false;

create index if not exists promo_post_blend_idx
  on public.promo_post (list_id, created_at desc);

-- ---------- promo_list: blend and fallback ----------
alter table public.promo_list
  -- Relative weights per ownership class. A 70/30 list converges on roughly
  -- seven owned links for every three shared ones over a rolling window.
  add column if not exists source_mix jsonb not null
    default '{"owned": 70, "partner": 0, "shared": 30}'::jsonb,

  -- What to do when one side of the blend has nothing available. The default
  -- keeps a list with no original content posting, while capping how far it
  -- may drift into being a pure shared-content firehose.
  add column if not exists fallback_policy jsonb not null
    default '{"whenOwnedQueueEmpty": "use_shared", "whenSharedQueueEmpty": "use_owned", "maxFallbackItemsPerDay": 3}'::jsonb;

-- ---------- RLS ----------
-- promo_feed and promo_feed_item are shared across users and carry no
-- user_id, so they are readable only through a subscription the caller owns.
-- The worker uses the service role and bypasses all of this.

alter table public.promo_feed enable row level security;
create policy "promo_feed readable via a subscribed list"
  on public.promo_feed for select
  using (
    exists (
      select 1
      from public.promo_source s
      join public.promo_list l on l.id = s.list_id
      where s.feed_id = promo_feed.id and l.user_id = auth.uid()
    )
  );

alter table public.promo_feed_item enable row level security;
create policy "promo_feed_item readable via a subscribed list"
  on public.promo_feed_item for select
  using (
    exists (
      select 1
      from public.promo_source s
      join public.promo_list l on l.id = s.list_id
      where s.feed_id = promo_feed_item.feed_id and l.user_id = auth.uid()
    )
  );

alter table public.promo_source enable row level security;
create policy "promo_source via owned list"
  on public.promo_source for all
  using (
    exists (
      select 1 from public.promo_list l
      where l.id = list_id and l.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.promo_list l
      where l.id = list_id and l.user_id = auth.uid()
    )
  );

-- ---------- updated_at ----------
create trigger promo_feed_updated_at
  before update on public.promo_feed
  for each row execute function public.promo_set_updated_at();

-- ---------- Grants ----------
-- Feeds and their items are never written from the browser: only the worker
-- ingests, and only server actions (service role) create feed rows.
grant select on public.promo_feed to authenticated;
grant select on public.promo_feed_item to authenticated;
grant select, insert, update, delete on public.promo_source to authenticated;

grant all on public.promo_feed to service_role;
grant all on public.promo_feed_item to service_role;
grant all on public.promo_source to service_role;
