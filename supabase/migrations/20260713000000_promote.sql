-- Promote: drip-publish AI-written marketing pitches across all connected
-- social accounts on a recurring cadence. Global (account-level), not
-- per-project. Reuses sp_account for connections and consume_credit for billing.

-- ---------- promo_list ----------
create table if not exists public.promo_list (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,

  name text not null default 'Promote list',
  status text not null default 'running'
    check (status in ('running','paused','archived')),

  -- Drip cadence in seconds. Default 1800 (30 min).
  cadence_seconds int not null default 1800
    check (cadence_seconds between 300 and 604800),

  -- 'trickle' = one post per tick, round-robin (default, safest).
  -- 'burst'   = one post to EVERY targeted account each tick.
  post_mode text not null default 'trickle'
    check (post_mode in ('trickle','burst')),

  -- NULL target_account_ids => "all active connected accounts" (dynamic).
  -- Non-null => an explicit pinned array of sp_account ids.
  target_account_ids uuid[],

  -- Freeform brand voice / global generation instructions.
  brand_voice text,

  -- Optional local quiet-hours window (Phase 2).
  quiet_start smallint,          -- hour 0-23, null = disabled
  quiet_end   smallint,
  timezone text,

  -- Scheduler bookkeeping.
  next_run_at timestamptz not null default now(),
  last_run_at timestamptz,

  -- Auto-pause reason (e.g. 'insufficient_credits').
  pause_reason text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index on public.promo_list (status, next_run_at);
create index on public.promo_list (user_id);

-- ---------- promo_link ----------
create table if not exists public.promo_link (
  id uuid primary key default gen_random_uuid(),
  list_id uuid not null references public.promo_list(id) on delete cascade,

  url text not null,
  title text,                    -- best-effort fetched <title>/og:title
  angle text,                    -- per-link marketing hint, optional

  -- Fairness: least-recently-promoted link is picked first.
  last_promoted_at timestamptz,
  times_promoted int not null default 0,

  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  unique (list_id, url)
);

create index on public.promo_link (list_id, enabled, last_promoted_at);

-- ---------- promo_post ----------
create table if not exists public.promo_post (
  id uuid primary key default gen_random_uuid(),
  list_id uuid not null references public.promo_list(id) on delete cascade,
  link_id uuid not null references public.promo_link(id) on delete cascade,
  account_id uuid not null references public.sp_account(id) on delete cascade,

  platform text not null,        -- denormalized from sp_account for querying
  body text not null,            -- the LLM-generated pitch actually posted
  provider text,                 -- 'anthropic' | 'openai'
  model text,

  status text not null default 'pending'
    check (status in ('pending','posted','failed','skipped')),
  external_post_id text,         -- platform post id / permalink
  error text,
  credits_spent int not null default 0,

  created_at timestamptz not null default now(),
  posted_at timestamptz
);

create index on public.promo_post (list_id, created_at desc);
create index on public.promo_post (link_id, platform);

-- ---------- RLS ----------
alter table public.promo_list enable row level security;
create policy "promo_list owner all"
  on public.promo_list for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

alter table public.promo_link enable row level security;
create policy "promo_link via owned list"
  on public.promo_link for all
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

alter table public.promo_link enable row level security;

alter table public.promo_post enable row level security;
create policy "promo_post via owned list"
  on public.promo_post for select
  using (
    exists (
      select 1 from public.promo_list l
      where l.id = list_id and l.user_id = auth.uid()
    )
  );

-- ---------- updated_at trigger ----------
-- Reuse the generic set_updated_at trigger function if it exists, otherwise create one.
create or replace function public.promo_set_updated_at()
returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger promo_list_updated_at
  before update on public.promo_list
  for each row execute function public.promo_set_updated_at();

-- ---------- Service-role grants ----------
-- The worker uses the service-role key which bypasses RLS, but these grants
-- ensure the tables are accessible to authenticated users via the anon key.
grant select, insert, update, delete on public.promo_list to authenticated;
grant select, insert, update, delete on public.promo_link to authenticated;
grant select on public.promo_post to authenticated;
grant all on public.promo_list to service_role;
grant all on public.promo_link to service_role;
grant all on public.promo_post to service_role;
