-- The shared @profullstack/profile fields on public.profiles.
--
-- Apply ONE FILE AT A TIME by hand against the dev2 self-hosted database
-- (`docker exec -i supabase-db psql -U postgres -d postgres -1 < this file`,
-- then `notify pgrst, 'reload schema'`). Never `db push`: prod's ledger has
-- diverged from this directory. Additive only, so it is safe before the deploy.
--
-- email already exists. The package's store also reads/writes updated_at.
-- Nothing is renamed or dropped; display_name stays as it is.

alter table public.profiles add column if not exists first_name text;
alter table public.profiles add column if not exists last_name text;
alter table public.profiles add column if not exists company_domain text;
alter table public.profiles add column if not exists job_title text;
alter table public.profiles add column if not exists linkedin_url text;
alter table public.profiles add column if not exists updated_at timestamptz default now();

create index if not exists profiles_email_lower on public.profiles (lower(email));

-- One-time backfill, idempotent: split display_name into first/last only when
-- it looks like a person's "First Last" (capitalised words of letters,
-- apostrophes and hyphens). Emails, handles, and anything with digits, dots or
-- @ are left alone. Never overwrites a value already present.
update public.profiles
   set first_name = coalesce(first_name, split_part(btrim(display_name), ' ', 1)),
       last_name  = coalesce(last_name, nullif(btrim(substr(btrim(display_name),
                      length(split_part(btrim(display_name), ' ', 1)) + 1)), ''))
 where (first_name is null or last_name is null)
   and display_name is not null
   and display_name is distinct from email
   and btrim(display_name) ~ '^[[:upper:]][[:alpha:]''’-]*( [[:upper:]][[:alpha:]''’-]*)+$';
