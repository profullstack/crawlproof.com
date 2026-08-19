-- Promote durable jobs: make a publication the unit of work, and make it
-- impossible to publish the same thing twice.
--
-- WHAT WAS WRONG
--
-- The drip sweep decided and published in one pass. It selected every
-- promo_list whose next_run_at was due, "claimed" each one by pushing
-- next_run_at forward, then generated a pitch and posted it.
--
-- That claim does not hold. The update carries no predicate on next_run_at, so
-- two sweeps that both read the same due row both win it. The worker runs the
-- sweep on a 60s interval *and* out-of-band whenever a user clicks "Post now"
-- (worker/index.ts, POST /dashboard/promote/sweep), so overlapping runs are a
-- designed-in feature, not a rare race.
--
-- Worse, nothing downstream is idempotent. If the process dies after
-- postViaAccount() has published but before the promo_post insert, there is no
-- record that it happened. last_promoted_at is only stamped at the end of the
-- list, so the same link is still least-recently-promoted on the next tick and
-- goes out again. The user sees a duplicate; we see nothing.
--
-- WHAT THIS CHANGES
--
-- A promo_job is one intended publication: one link, to one account, at one
-- destination, for one scheduling slot. It is written *before* anything is
-- published and carries a deterministic idempotency_key over exactly that
-- intent, with a unique index behind it.
--
-- Two sweeps racing the same due list derive the same key from the same slot,
-- so the second insert loses to the index and plans nothing. Then a worker
-- takes a job by compare-and-swap -- update ... where state = 'queued' -- so
-- only one worker can move a job to 'publishing'. Postgres decides, not
-- read-then-write.
--
-- AT MOST ONCE, DELIBERATELY
--
-- A job found stuck in 'publishing' past its lease is NOT retried. None of the
-- social providers accept an idempotency key, so a publish that was
-- interrupted has genuinely unknown outcome: it may be live on the platform.
-- Retrying it is the duplicate we are here to prevent. Such a job is failed
-- with the outcome recorded as unknown and surfaced in history, and a human
-- decides. Retry is reserved for failures that provably happened *before* the
-- publish call.
--
-- ORDERING: this table must exist before the code that selects it ships. A
-- sweep selecting a missing column makes PostgREST error the whole select,
-- which returns null rows and stops every campaign silently -- the failure
-- mode that cost us a day when promo_list.source_mix shipped ahead of its
-- migration. planJobs() logs loudly rather than quietly skipping if this table
-- is missing, but the ordering is still the actual fix.

create table if not exists public.promo_job (
  id uuid primary key default gen_random_uuid(),

  -- Denormalized owner, so the worker can bill and the user can read their own
  -- jobs without a join through promo_list. References profiles, matching
  -- promo_list.user_id -- not auth.users, which would let a job outlive the
  -- profile row every other promote table is keyed to.
  user_id uuid not null references public.profiles(id) on delete cascade,

  list_id uuid not null references public.promo_list(id) on delete cascade,
  link_id uuid not null references public.promo_link(id) on delete cascade,
  account_id uuid not null references public.sp_account(id) on delete cascade,

  platform text not null,

  -- Where inside the platform this goes. Empty string for platforms with a
  -- single destination (a Bluesky account has one timeline); 'r/bitcoin' once
  -- the Reddit provider lands. Part of the idempotency key, so it is not null
  -- -- a null would make every key distinct under SQL comparison.
  destination_key text not null default '',

  kind text not null default 'original'
    check (kind in ('original', 'crosspost', 'reshare')),

  -- A crosspost is scheduled off the original it follows.
  parent_job_id uuid references public.promo_job(id) on delete set null,

  -- Resolved inputs. Frozen at plan time so a job publishes what it was
  -- planned to publish, even if the link or the campaign changes underneath.
  -- resolved_body is null until the job is claimed, because writing the pitch
  -- costs an LLM call and only the worker that wins the claim should make it.
  resolved_url text not null,
  resolved_title text,
  resolved_body text,

  -- Denormalized selection context, so history explains itself without
  -- re-deriving the blend that produced it.
  ownership text not null default 'owned'
    check (ownership in ('owned', 'partner', 'shared')),
  source_id uuid references public.promo_source(id) on delete set null,
  via_fallback boolean not null default false,

  -- The tick this job belongs to: the promo_list.next_run_at value the sweep
  -- observed as due. Two sweeps reading the same due row see the same slot.
  slot_at timestamptz not null,
  scheduled_at timestamptz not null default now(),

  -- 'preflighting', 'blocked' and 'retrying' are unused today. They are in the
  -- constraint now so the Reddit provider, which needs all three, does not
  -- need a migration to change a check.
  state text not null default 'queued'
    check (state in (
      'queued', 'preflighting', 'blocked', 'publishing',
      'published', 'retrying', 'failed', 'cancelled'
    )),

  attempt_count int not null default 0,
  last_error text,

  -- Lease bookkeeping. locked_at is stamped when a worker wins the claim; a
  -- job still 'publishing' long after it is a crashed worker, not a slow one.
  locked_at timestamptz,

  idempotency_key text not null,

  -- The attempt this job produced, once it has produced one.
  promo_post_id uuid references public.promo_post(id) on delete set null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The guarantee. Everything above is bookkeeping; this is the part that makes
-- a double publication impossible rather than unlikely.
create unique index if not exists promo_job_idempotency_key_uidx
  on public.promo_job (idempotency_key);

-- The claim scan: queued work, oldest slot first.
create index if not exists promo_job_claimable_idx
  on public.promo_job (state, scheduled_at)
  where state in ('queued', 'publishing');

-- History, and the campaign detail page.
create index if not exists promo_job_list_idx
  on public.promo_job (list_id, created_at desc);

-- ---------- RLS ----------
-- Owner-readable. Jobs are written by the worker under the service role, which
-- bypasses this; a user may read their own and cancel a queued one, which is
-- what the approval modes in the architecture doc will need.

alter table public.promo_job enable row level security;

create policy "promo_job owner all"
  on public.promo_job for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ---------- updated_at ----------
create trigger promo_job_updated_at
  before update on public.promo_job
  for each row execute function public.promo_set_updated_at();
