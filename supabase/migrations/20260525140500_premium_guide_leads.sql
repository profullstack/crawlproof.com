-- Leads captured by the public /get-guide PDF gateway.
-- Distinct from marketing_contacts: this table keeps the form context
-- that helps qualify a premium guide request. marketing_contacts remains
-- the source of truth for newsletter consent/unsubscribe state.

create table if not exists public.premium_guide_leads (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  name text not null,
  company text,
  role text,
  team_size text,
  marketing_opt_in boolean not null default false,
  source text not null default 'get_guide',
  created_at timestamptz not null default now()
);

create index if not exists premium_guide_leads_email_idx
  on public.premium_guide_leads (lower(email));

create index if not exists premium_guide_leads_created_at_idx
  on public.premium_guide_leads (created_at desc);

alter table public.premium_guide_leads enable row level security;

drop policy if exists "premium_guide_leads service-role only"
  on public.premium_guide_leads;

create policy "premium_guide_leads service-role only"
  on public.premium_guide_leads
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');
