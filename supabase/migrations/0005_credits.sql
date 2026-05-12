-- Credits model: 1 credit = 1 scan = $1. Replaces the Stripe Pro tier.
-- New signups get 3 free credits so they can try without paying.

alter table public.profiles
  add column if not exists credits_balance int not null default 3;

-- Bump existing rows up to the new signup default if they're at 0.
update public.profiles set credits_balance = 3 where credits_balance = 0;

-- New-user trigger: signup gives 3 credits via the column default — nothing
-- extra needed here, but bump the existing trigger function to be explicit.

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, display_name, credits_balance)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'full_name', new.email), 3)
  on conflict (id) do nothing;
  return new;
end;
$$;

-- ============================================================
-- credit_purchases — one row per CoinPay session, regardless of status.
-- ============================================================
create table if not exists public.credit_purchases (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  pack_id text not null,
  credits_added int not null check (credits_added > 0),
  amount_cents int not null check (amount_cents > 0),
  currency text not null default 'USD',
  status text not null default 'pending' check (status in ('pending','complete','failed','refunded')),
  coinpay_payment_id text unique,
  coinpay_event jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists credit_purchases_owner_idx
  on public.credit_purchases(owner_id, created_at desc);
create index if not exists credit_purchases_status_idx
  on public.credit_purchases(status);

alter table public.credit_purchases enable row level security;

create policy "credit_purchases owner select"
  on public.credit_purchases for select
  using (auth.uid() = owner_id);

-- ============================================================
-- consume_credit: atomically deduct 1 credit if balance > 0.
-- Returns true if a credit was spent.
-- ============================================================
create or replace function public.consume_credit(p_owner uuid)
returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_remaining int;
begin
  update public.profiles
  set credits_balance = credits_balance - 1
  where id = p_owner and credits_balance > 0
  returning credits_balance into v_remaining;
  return v_remaining is not null;
end;
$$;

grant execute on function public.consume_credit(uuid) to authenticated, service_role;

-- ============================================================
-- credit_purchase_complete: marks a purchase complete and adds the credits.
-- Idempotent — calling twice for the same payment_id is safe.
-- ============================================================
create or replace function public.credit_purchase_complete(p_payment_id text, p_event jsonb)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_purchase public.credit_purchases%rowtype;
begin
  select * into v_purchase
  from public.credit_purchases
  where coinpay_payment_id = p_payment_id
  for update;

  if not found then
    return;
  end if;
  if v_purchase.status = 'complete' then
    return;
  end if;

  update public.credit_purchases
  set status = 'complete', completed_at = now(), coinpay_event = p_event
  where id = v_purchase.id;

  update public.profiles
  set credits_balance = credits_balance + v_purchase.credits_added
  where id = v_purchase.owner_id;
end;
$$;

grant execute on function public.credit_purchase_complete(text, jsonb) to service_role;
