-- What the AI actually costs, recorded per call.
--
-- Anthropic's cost and usage reports need an Admin key (sk-ant-admin01-...);
-- a normal API key gets 401 on them, so the running total cannot be read back
-- from the provider by the app that is spending the money. Token counts come
-- back on every response though, and the per-model prices are published, so
-- the spend is computable at the point of the call — and that is also the
-- only place that knows which feature caused it.
--
-- Cost is stored in micro-dollars as an integer. Model prices are quoted per
-- million tokens, so a single Haiku call rounds to zero cents; summing cents
-- would report a day of real spend as $0.

create table if not exists public.ai_usage (
  id uuid primary key default gen_random_uuid(),
  occurred_at timestamptz not null default now(),

  provider text not null,
  model text not null,
  -- Which part of the product spent it. Without this the total answers "how
  -- much" but never "on what", which is the question that follows.
  feature text,

  input_tokens int not null default 0,
  output_tokens int not null default 0,
  cache_read_tokens int not null default 0,
  cache_write_tokens int not null default 0,

  -- Millionths of a dollar. $1.00 = 1000000.
  cost_micros bigint not null default 0,
  -- The rates used, so a later price change doesn't silently rewrite history.
  rate_input_micros_per_mtok bigint,
  rate_output_micros_per_mtok bigint
);

create index if not exists ai_usage_occurred_idx on public.ai_usage(occurred_at desc);
create index if not exists ai_usage_feature_idx on public.ai_usage(feature, occurred_at desc);

-- Recording spend must never be able to fail a request that already
-- succeeded, so writes go through the service client and nothing reads this
-- from a browser.
alter table public.ai_usage enable row level security;

-- One alert per threshold per day. The check runs on a schedule, so without
-- this a day that crosses the line would mail on every subsequent run.
create table if not exists public.ai_spend_alerts (
  id uuid primary key default gen_random_uuid(),
  -- Local day the alert covers.
  day date not null,
  threshold_micros bigint not null,
  spend_micros bigint not null,
  sent_to text not null,
  sent_at timestamptz not null default now()
);

create unique index if not exists ai_spend_alerts_day_threshold_idx
  on public.ai_spend_alerts(day, threshold_micros);

alter table public.ai_spend_alerts enable row level security;

comment on table public.ai_usage is
  'Per-call AI spend, computed from returned token counts and published per-model rates. Anthropic cost reporting needs an Admin key, so this is the only figure the app itself can see.';

comment on column public.ai_usage.cost_micros is
  'Millionths of a dollar. Cents would round a whole day of Haiku calls to zero.';
