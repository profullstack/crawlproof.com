-- Opt-in marketing list. Distinct from audits.pdf_email, which is a
-- transactional address used once to send the PDF report. Rows here mean
-- the visitor explicitly checked the "email me CrawlProof updates" box.
--
-- Service-role only — RLS enabled with no policies; client code never
-- reads or writes this table directly. The unsubscribe page hits it
-- through the service client.

create table if not exists public.marketing_contacts (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  source text not null,
  consented_at timestamptz not null default now(),
  unsubscribed_at timestamptz,
  unsubscribe_token text not null unique default encode(gen_random_bytes(16), 'hex'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Case-insensitive uniqueness on email.
create unique index if not exists marketing_contacts_email_lower_idx
  on public.marketing_contacts (lower(email));

create index if not exists marketing_contacts_unsubscribed_idx
  on public.marketing_contacts (unsubscribed_at)
  where unsubscribed_at is null;

alter table public.marketing_contacts enable row level security;
-- No policies → anon/authenticated have no access. service_role bypasses RLS.

create or replace function public.marketing_contacts_touch_updated_at()
returns trigger language plpgsql set search_path = public as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists marketing_contacts_updated_at on public.marketing_contacts;
create trigger marketing_contacts_updated_at
  before update on public.marketing_contacts
  for each row execute function public.marketing_contacts_touch_updated_at();
