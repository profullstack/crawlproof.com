-- Keep the user agent, and let a project act on it.
--
-- Until now the tracker derived a device type from the User-Agent and threw the
-- string away, on purpose: "like the geo rollup we store only aggregate counts,
-- never the raw UA string". That was a defensible default and it had one cost
-- nobody noticed until a customer asked the obvious question. A dashboard could
-- say 8,341 visitors arrived from San Jose and that they were bots, but never
-- WHICH bot -- so the only honest answer to "who is this?" was "check your own
-- server logs", which rather defeats the point of an analytics product.
--
-- Three things here: retention, rules, and the state that makes backoff possible.

-- 1. Retention.
--
-- Bounded to 512 characters. A real User-Agent is under 200; anything longer is
-- padding or an attempt to make a row expensive, and truncating is better than
-- rejecting because the prefix is the identifying part.
alter table tracker_events add column if not exists user_agent text;

-- Bots are the reason this exists, so they get the index. Human agents are
-- stored for completeness and read rarely.
create index if not exists tracker_events_agent_idx
  on tracker_events (project_id, user_agent)
  where user_agent is not null;

-- 2. Rules: what a project wants done about an agent.
--
-- Patterns rather than exact strings, because a crawler varies its UA by version
-- and nobody wants to re-ban GPTBot every release. `contains` covers almost
-- every real case; `regex` is there for the one that is not, and is applied in
-- the application rather than in SQL so a bad pattern cannot cost a table scan.
create table if not exists tracker_agent_rules (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references projects(id) on delete cascade,
  pattern      text not null check (length(btrim(pattern)) between 2 and 200),
  match_type   text not null default 'contains' check (match_type in ('contains','exact','regex')),
  -- ban: never record, always refuse. throttle: record, but rate limit.
  action       text not null default 'throttle' check (action in ('ban','throttle')),
  -- Requests per hour before a throttle rule bites. Null takes the project default.
  hourly_limit int check (hourly_limit is null or hourly_limit > 0),
  note         text,
  created_at   timestamptz not null default now(),
  unique (project_id, pattern, match_type)
);

create index if not exists tracker_agent_rules_project_idx
  on tracker_agent_rules (project_id);

-- 3. State: what each agent has actually done lately.
--
-- Keyed by a normalised agent rather than the raw string, so a crawler that
-- appends a build number to every request cannot reset its own counter by
-- looking slightly different each time.
create table if not exists tracker_agent_state (
  project_id      uuid not null references projects(id) on delete cascade,
  agent_key       text not null,
  -- The full string as last seen, for the dashboard to show and for a human to
  -- recognise. The KEY is what the counting is done on.
  user_agent      text,
  window_started  timestamptz not null default now(),
  window_count    int not null default 0,
  -- Consecutive windows in which the limit was exceeded. This is the exponent.
  strikes         int not null default 0,
  blocked_until   timestamptz,
  first_throttled_at timestamptz,
  -- When we last told this agent HOW to resolve it. Once per backoff period,
  -- because repeating the terms on every request is just more traffic.
  notified_at     timestamptz,
  total_requests  bigint not null default 0,
  last_seen_at    timestamptz not null default now(),
  primary key (project_id, agent_key)
);

create index if not exists tracker_agent_state_blocked_idx
  on tracker_agent_state (project_id, blocked_until)
  where blocked_until is not null;

comment on table tracker_agent_rules is
  'Per-project ban/throttle rules matched against the request User-Agent.';
comment on table tracker_agent_state is
  'Rolling per-agent request counters and exponential backoff state.';
comment on column tracker_events.user_agent is
  'Raw User-Agent, truncated to 512 chars. Retained so a dashboard can name a bot rather than only counting it.';
