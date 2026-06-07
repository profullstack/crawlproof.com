-- organization_invitations: pending email invitations to join an org,
-- mirroring project_invitations. Accepted invites add a row to
-- organization_members with role 'member' (handled in the app via the
-- service client). organization_members already exists from
-- 20260606130000_organizations_and_recent_outreach.sql.
create table if not exists public.organization_invitations (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null references public.organizations(id) on delete cascade,
  email           text        not null,
  token           text        not null unique default encode(gen_random_bytes(32), 'hex'),
  invited_by      uuid        not null references public.profiles(id),
  expires_at      timestamptz not null default (now() + interval '7 days'),
  accepted_at     timestamptz,
  created_at      timestamptz not null default now(),
  unique (organization_id, email)
);

create index if not exists organization_invitations_org_idx
  on public.organization_invitations(organization_id, created_at desc);

alter table public.organization_invitations enable row level security;

drop policy if exists "organization_invitations owner all" on public.organization_invitations;
create policy "organization_invitations owner all"
  on public.organization_invitations for all
  using  ((select public.is_org_owner(organization_id, auth.uid())))
  with check ((select public.is_org_owner(organization_id, auth.uid())));
