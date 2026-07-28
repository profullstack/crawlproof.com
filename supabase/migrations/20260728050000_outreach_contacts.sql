-- One record per person, shared across every campaign and project.
--
-- outreach_prospects is unique on (project_id, channel, target_key), so the
-- same person becomes a separate row in every project that finds them — with
-- separate contact details, separate history, and nothing that notices when
-- two campaigns are about to email them in the same week.
--
-- This is the source of truth for who someone is. Prospects keep their role:
-- one business's place in one project's funnel. What a prospect no longer
-- owns is the person's identity.
--
-- The merge rule matters more than the schema: discovery fills gaps, it does
-- not overwrite. A scraped company name must never replace one a human typed,
-- and a second campaign finding a different phone number should not silently
-- discard the first. Conflicting values land in `alternates` instead.

create table if not exists public.outreach_contacts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,

  -- The dedupe key. Lower-cased on write; the unique index below is what
  -- actually enforces one row per person per org.
  email text not null,
  -- Their own domain, when known. Useful for matching a contact discovered by
  -- site before any address was found.
  host text,

  full_name text,
  title text,
  company_name text,
  -- The company's own site, distinct from `host`: a contact found on a
  -- personal portfolio may work somewhere else entirely, and conflating the
  -- two loses whichever was written second.
  company_site text,
  -- What this contact does, and for whom. Recorded per contact rather than
  -- inferred from the campaign that found them, because one contact can be
  -- reached by campaigns in several niches and the campaign is not evidence
  -- about the person.
  niche text,
  industry text,
  -- Where the record came from, per field, and the page it was read from.
  -- Provenance is worth keeping for its own sake: it is what lets you answer
  -- "why do we think this is their email" a year later.
  source_url text,
  -- Country, when it can be determined. Which rules apply to a record
  -- depends on where the person is, not where the campaign ran.
  country text,
  phone text,
  postal_address text,
  linkedin_url text,
  -- Other profiles keyed by network: {"x": "...", "github": "..."}.
  socials jsonb not null default '{}'::jsonb,

  -- Values that arrived later and disagreed with what was already stored.
  -- Kept rather than dropped so a human can adjudicate, and so an enrichment
  -- pass that turns out to be wrong is reversible.
  alternates jsonb not null default '[]'::jsonb,
  -- Where each field came from, so a hand-entered value can be told apart
  -- from a scraped one and protected accordingly.
  field_sources jsonb not null default '{}'::jsonb,

  -- Set by a human. Blocks every campaign in the org, not just the one that
  -- caused it — the whole point of a shared record.
  do_not_contact boolean not null default false,
  do_not_contact_reason text,

  first_seen_at timestamptz not null default now(),
  last_enriched_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One row per person per organization. Case-insensitive, because an address
-- that differs only in capitalisation is the same inbox.
create unique index if not exists outreach_contacts_org_email_idx
  on public.outreach_contacts(organization_id, lower(email));

create index if not exists outreach_contacts_org_host_idx
  on public.outreach_contacts(organization_id, host);

-- Niche and industry are how a list gets segmented, so they get an index
-- rather than being filtered out of a full scan.
create index if not exists outreach_contacts_org_niche_idx
  on public.outreach_contacts(organization_id, niche)
  where niche is not null;

-- Prospects point at the person; the person does not point back, because one
-- contact can be a prospect in several projects at once.
alter table public.outreach_prospects
  add column if not exists contact_id uuid references public.outreach_contacts(id) on delete set null;

create index if not exists outreach_prospects_contact_idx
  on public.outreach_prospects(contact_id)
  where contact_id is not null;

alter table public.outreach_contacts enable row level security;

drop policy if exists "outreach_contacts org read" on public.outreach_contacts;
-- The outer column must be qualified. Written as `m.organization_id =
-- organization_id`, Postgres resolves the bare name to the subquery's own
-- table, the predicate becomes a tautology, and every member of any org can
-- read every contact in the table.
create policy "outreach_contacts org read"
  on public.outreach_contacts for select
  using (
    exists (
      select 1 from public.organization_members m
      where m.organization_id = public.outreach_contacts.organization_id
        and m.user_id = auth.uid()
    )
  );

drop trigger if exists outreach_contacts_set_updated_at on public.outreach_contacts;
create trigger outreach_contacts_set_updated_at
  before update on public.outreach_contacts
  for each row execute function public.lx_set_updated_at();

comment on table public.outreach_contacts is
  'One record per person per organization, shared across campaigns and projects. Discovery merges into it; it never overwrites a human-set value.';

comment on column public.outreach_contacts.alternates is
  'Conflicting values seen later, kept rather than discarded so a human can adjudicate.';
