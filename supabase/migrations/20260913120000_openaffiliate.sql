-- OpenAffiliate: the affiliate program CrawlProof runs, and the programs its
-- users join elsewhere. Spec: https://logicsrc.com/docs/openaffiliate
--
-- Apply ONE FILE AT A TIME via the Supabase MCP against ywcizjsgrcmhgyplldac
-- (prod's migration history has diverged from this directory, so `db push`
-- would replay files prod already has). Nothing here backfills a row that
-- serving reads; the code treats a missing table as "no affiliate program".
--
-- Why this is not the 2026-06 referral tables. `referral_codes` and
-- `referral_usages` were issued by an npm package that captured a cookie and
-- never recorded a commission: no code in this repo writes referral_usages.
-- The affiliate rail needs the half that was missing, a conversion with a
-- hold, a reason on reversal and a payout with a tx, and it needs to be
-- readable by the affiliate through a bearer token, because that is what the
-- spec promises. So it is its own set of tables, and the old ones stay put.
--
-- Two sides live here:
--
--   MERCHANT (we run a program): affiliate_memberships, affiliate_clicks,
--   affiliate_attributions, affiliate_conversions, affiliate_payouts and
--   affiliate_events (the outbound webhook queue).
--
--   AFFILIATE (our users join other merchants' programs): affiliate_programs
--   (a directory of descriptors read from /.well-known/openaffiliate.json)
--   and affiliate_joins (one row per user per program, holding the token the
--   merchant handed back and the last ledger read).
--
-- Amounts are CENTS. A commission on a credits pack is dollars, not fractions
-- of a cent, so the earn rail's micros are not needed here.

-- ─────────────────────────────────────────────────────────────────────────────
-- Memberships: one affiliate in our program
-- ─────────────────────────────────────────────────────────────────────────────
-- An affiliate is a CrawlProof user (owner_id) or an outside party identified
-- by an OpenProfile.md URL (profile_url), or both. `code` is what goes in the
-- link (?oa=code). The token is stored hashed with the same pepper as API
-- tokens; the plaintext is shown once at join. `terms` is the program's `pays`
-- as it stood at the join, so the affiliate keeps a copy of what it agreed to.
create table if not exists public.affiliate_memberships (
  id uuid primary key default gen_random_uuid(),
  program text not null default 'partners',
  owner_id uuid references auth.users(id) on delete set null,
  profile_url text,
  kind text not null default 'person' check (kind in ('person','agent','organization')),
  display_name text,
  email text,
  pay_address text,
  webhook_url text,
  code text not null check (code ~ '^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$'),
  token_prefix text not null,
  token_hash text not null,
  status text not null default 'active'
    check (status in ('active','pending','refused','ended')),
  terms jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint affiliate_memberships_party check (owner_id is not null or profile_url is not null)
);
create unique index if not exists affiliate_memberships_code_idx
  on public.affiliate_memberships(program, lower(code));
create unique index if not exists affiliate_memberships_token_idx
  on public.affiliate_memberships(token_hash);
create unique index if not exists affiliate_memberships_owner_idx
  on public.affiliate_memberships(program, owner_id) where owner_id is not null;
create unique index if not exists affiliate_memberships_profile_idx
  on public.affiliate_memberships(program, lower(profile_url)) where profile_url is not null;
comment on table public.affiliate_memberships is
  'One affiliate in a program CrawlProof runs. code is the ?oa= value; token_hash is the peppered sha256 of the oa_ bearer token.';

-- ─────────────────────────────────────────────────────────────────────────────
-- Clicks: a navigation that carried ?oa=
-- ─────────────────────────────────────────────────────────────────────────────
-- Only a navigation lands here (the middleware ignores the parameter on an
-- image, frame, script or prefetch). One row per click; the cookie set with
-- it is what a later purchase is attributed through.
create table if not exists public.affiliate_clicks (
  id uuid primary key default gen_random_uuid(),
  membership_id uuid not null references public.affiliate_memberships(id) on delete cascade,
  landing text,
  referrer text,
  ip_hash text,
  user_agent text,
  at timestamptz not null default now()
);
create index if not exists affiliate_clicks_membership_idx
  on public.affiliate_clicks(membership_id, at desc);

-- ─────────────────────────────────────────────────────────────────────────────
-- Attributions: which affiliate a signed-in user belongs to right now
-- ─────────────────────────────────────────────────────────────────────────────
-- Written when a user with the cookie signs in or starts a purchase. One row
-- per user: last-touch replaces it while the window is open (that is the
-- program's `attribution: last`), and it expires `window` days after the click
-- it came from. The purchase webhook, which has no cookie, reads this.
create table if not exists public.affiliate_attributions (
  user_id uuid primary key references auth.users(id) on delete cascade,
  membership_id uuid not null references public.affiliate_memberships(id) on delete cascade,
  code text not null,
  clicked_at timestamptz not null,
  expires_at timestamptz not null,
  set_at timestamptz not null default now()
);
create index if not exists affiliate_attributions_membership_idx
  on public.affiliate_attributions(membership_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- Conversions: one event the program pays for
-- ─────────────────────────────────────────────────────────────────────────────
-- pending from the moment it is recorded, approved once held_until passes
-- without a refund, reversed with a reason when we take it back, paid when a
-- payout covers it. (event, order_ref) is the idempotency key, so a webhook
-- retry or a poll fallback cannot record a purchase twice. customer_id is
-- kept for our own reconciliation and is never sent to the affiliate.
create table if not exists public.affiliate_conversions (
  id uuid primary key default gen_random_uuid(),
  membership_id uuid not null references public.affiliate_memberships(id) on delete cascade,
  event text not null check (event in ('sale','subscription','signup','lead','install','other')),
  order_ref text not null,
  customer_id uuid,
  amount_cents integer not null default 0 check (amount_cents >= 0),
  commission_cents integer not null default 0 check (commission_cents >= 0),
  currency text not null default 'USD',
  status text not null default 'pending'
    check (status in ('pending','approved','reversed','paid')),
  held_until timestamptz,
  reason text,
  recurring_n integer,
  recurring_of integer,
  payout_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- A reversal without a reason is not a reversal (spec, "The ledger").
  constraint affiliate_conversions_reason check (status <> 'reversed' or reason is not null)
);
create unique index if not exists affiliate_conversions_order_idx
  on public.affiliate_conversions(event, order_ref);
create index if not exists affiliate_conversions_membership_idx
  on public.affiliate_conversions(membership_id, created_at desc);
create index if not exists affiliate_conversions_due_idx
  on public.affiliate_conversions(held_until) where status = 'pending';

-- ─────────────────────────────────────────────────────────────────────────────
-- Payouts: approved balance leaving through CoinPay
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.affiliate_payouts (
  id uuid primary key default gen_random_uuid(),
  membership_id uuid not null references public.affiliate_memberships(id) on delete cascade,
  amount_cents integer not null check (amount_cents > 0),
  method text not null default 'usdc/eip155:137',
  pay_address text not null,
  status text not null default 'requested'
    check (status in ('requested','sent','failed')),
  coinpay_payout_id text,
  tx_hash text,
  error text,
  created_at timestamptz not null default now(),
  settled_at timestamptz
);
create index if not exists affiliate_payouts_membership_idx
  on public.affiliate_payouts(membership_id, created_at desc);

-- ─────────────────────────────────────────────────────────────────────────────
-- Events: the outbound webhook queue
-- ─────────────────────────────────────────────────────────────────────────────
-- One row per event per membership that gave a webhook URL. Delivered by the
-- hourly cron with backoff; after a day of failures it stops, and the ledger
-- still has the row (spec, "Webhooks").
create table if not exists public.affiliate_events (
  id uuid primary key default gen_random_uuid(),
  membership_id uuid not null references public.affiliate_memberships(id) on delete cascade,
  event text not null,
  payload jsonb not null,
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  delivered_at timestamptz,
  last_error text,
  created_at timestamptz not null default now()
);
create index if not exists affiliate_events_due_idx
  on public.affiliate_events(next_attempt_at) where delivered_at is null;

-- ─────────────────────────────────────────────────────────────────────────────
-- Programs: the directory of merchants read from their own origin
-- ─────────────────────────────────────────────────────────────────────────────
-- `descriptor` is the merchant's file as fetched, unchanged. `verified` is
-- whether it came from the merchant's own /.well-known/ (spec, "Discovery").
create table if not exists public.affiliate_programs (
  id uuid primary key default gen_random_uuid(),
  origin text not null,
  descriptor jsonb,
  verified boolean not null default false,
  fetched_at timestamptz,
  error text,
  added_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists affiliate_programs_origin_idx
  on public.affiliate_programs(lower(origin));

-- ─────────────────────────────────────────────────────────────────────────────
-- Joins: our users' memberships in other merchants' programs
-- ─────────────────────────────────────────────────────────────────────────────
-- The token is the merchant's credential for the user's own ledger; we hold
-- it for the user, not against them (spec, "Directories" rule 4), so it is
-- readable only through the owner's session or API token.
create table if not exists public.affiliate_joins (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  origin text not null,
  program_id text not null,
  membership_ref text,
  code text,
  link text,
  token text,
  ledger_url text,
  status text not null default 'pending'
    check (status in ('active','pending','refused','ended')),
  terms jsonb,
  ledger jsonb,
  events jsonb not null default '[]'::jsonb,
  synced_at timestamptz,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists affiliate_joins_owner_program_idx
  on public.affiliate_joins(owner_id, lower(origin), program_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- RLS: owners read their own rows; every write goes through the service role
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.affiliate_memberships enable row level security;
alter table public.affiliate_clicks enable row level security;
alter table public.affiliate_attributions enable row level security;
alter table public.affiliate_conversions enable row level security;
alter table public.affiliate_payouts enable row level security;
alter table public.affiliate_events enable row level security;
alter table public.affiliate_programs enable row level security;
alter table public.affiliate_joins enable row level security;

drop policy if exists "own affiliate membership" on public.affiliate_memberships;
create policy "own affiliate membership" on public.affiliate_memberships
  for select using (owner_id = auth.uid());

drop policy if exists "own affiliate clicks" on public.affiliate_clicks;
create policy "own affiliate clicks" on public.affiliate_clicks
  for select using (exists (
    select 1 from public.affiliate_memberships m
    where m.id = affiliate_clicks.membership_id and m.owner_id = auth.uid()));

drop policy if exists "own affiliate conversions" on public.affiliate_conversions;
create policy "own affiliate conversions" on public.affiliate_conversions
  for select using (exists (
    select 1 from public.affiliate_memberships m
    where m.id = affiliate_conversions.membership_id and m.owner_id = auth.uid()));

drop policy if exists "own affiliate payouts" on public.affiliate_payouts;
create policy "own affiliate payouts" on public.affiliate_payouts
  for select using (exists (
    select 1 from public.affiliate_memberships m
    where m.id = affiliate_payouts.membership_id and m.owner_id = auth.uid()));

-- The directory is public by nature: it is other merchants' public files.
drop policy if exists "affiliate programs are public" on public.affiliate_programs;
create policy "affiliate programs are public" on public.affiliate_programs
  for select using (true);

drop policy if exists "own affiliate joins" on public.affiliate_joins;
create policy "own affiliate joins" on public.affiliate_joins
  for select using (owner_id = auth.uid());

-- ─────────────────────────────────────────────────────────────────────────────
-- Payout: move approved conversions to paid under one lock
-- ─────────────────────────────────────────────────────────────────────────────
-- Debits first, sends second (the same order as earn_request_payout): the
-- conversions flip to paid inside this transaction, CoinPay is called by the
-- app afterwards, and a failed send calls affiliate_fail_payout to put them
-- back. Money can therefore be delayed by a CoinPay outage but never sent
-- twice. Every table reference is aliased and qualified; see the note in
-- earn_rail about RETURNS TABLE ambiguity.
create or replace function public.affiliate_request_payout(
  p_membership uuid,
  p_method text,
  p_address text,
  p_min_cents integer default 0
) returns table (payout_id uuid, amount_cents integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_total integer;
  v_payout uuid;
begin
  if p_address is null or length(trim(p_address)) = 0 then
    raise exception 'affiliate_request_payout: no payout address on the membership';
  end if;

  -- Serialise on the membership so two requests cannot both sum the same rows.
  perform 1 from public.affiliate_memberships m where m.id = p_membership for update;
  if not found then
    raise exception 'affiliate_request_payout: no such membership';
  end if;

  select coalesce(sum(c.commission_cents), 0) into v_total
    from public.affiliate_conversions c
   where c.membership_id = p_membership and c.status = 'approved';

  if v_total <= 0 then
    raise exception 'affiliate_request_payout: nothing approved to pay';
  end if;
  if v_total < p_min_cents then
    raise exception 'affiliate_request_payout: approved balance is below the program minimum';
  end if;

  insert into public.affiliate_payouts (membership_id, amount_cents, method, pay_address)
  values (p_membership, v_total, p_method, p_address)
  returning id into v_payout;

  update public.affiliate_conversions c
     set status = 'paid', payout_id = v_payout, updated_at = now()
   where c.membership_id = p_membership and c.status = 'approved';

  return query select v_payout, v_total;
end;
$$;

create or replace function public.affiliate_fail_payout(p_payout uuid, p_error text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.affiliate_payouts p
     set status = 'failed', error = left(coalesce(p_error, 'failed'), 500)
   where p.id = p_payout and p.status = 'requested';
  if not found then
    return;
  end if;
  update public.affiliate_conversions c
     set status = 'approved', payout_id = null, updated_at = now()
   where c.payout_id = p_payout and c.status = 'paid';
end;
$$;

revoke all on function public.affiliate_request_payout(uuid, text, text, integer) from public, anon, authenticated;
revoke all on function public.affiliate_fail_payout(uuid, text) from public, anon, authenticated;
grant execute on function public.affiliate_request_payout(uuid, text, text, integer) to service_role;
grant execute on function public.affiliate_fail_payout(uuid, text) to service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- Cron: approve what is past its hold, deliver webhooks, pay on schedule,
-- re-read the directory. The route does the work; this only rings the bell.
-- ─────────────────────────────────────────────────────────────────────────────
select cron.schedule(
  'crawlproof-affiliate',
  '23 * * * *',
  $cron$
  select net.http_post(
    url := current_setting('app.site_url', true) || '/api/cron/affiliate',
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'x-cron-secret', current_setting('app.cron_secret', true)
    ),
    body := '{}'::jsonb
  );
  $cron$
);
