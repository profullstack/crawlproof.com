-- Admin-only credit-grant flow.
--
--   profiles.is_admin — gates the /admin route + the grantCredits
--   server action. Default false; the row that flips it is the
--   bootstrap update below (anthony@profullstack.com).
--
--   admin_credit_grants — audit trail for every manual grant so the
--   ledger reconciles (signup default = 3, paid purchases via
--   credit_purchases, admin grants via this table).

alter table public.profiles
  add column if not exists is_admin boolean not null default false;

-- Bootstrap: flag the founder as admin so the page is usable from
-- the moment this migration lands. Subsequent admins get flipped
-- via the same admin UI or a SQL update.
update public.profiles
  set is_admin = true
  where lower(email) = lower('anthony@profullstack.com');

create table if not exists public.admin_credit_grants (
  id uuid primary key default gen_random_uuid(),
  granted_by uuid not null references public.profiles(id) on delete restrict,
  recipient_id uuid not null references public.profiles(id) on delete cascade,
  recipient_email text not null,
  credits int not null check (credits <> 0),
  reason text,
  created_at timestamptz not null default now()
);

create index if not exists admin_credit_grants_recipient_idx
  on public.admin_credit_grants(recipient_id, created_at desc);
create index if not exists admin_credit_grants_granted_by_idx
  on public.admin_credit_grants(granted_by, created_at desc);

alter table public.admin_credit_grants enable row level security;

-- Recipients can see what they received; admins can see everything.
create policy "admin_credit_grants recipient or admin select"
  on public.admin_credit_grants for select
  using (
    auth.uid() = recipient_id
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.is_admin
    )
  );
