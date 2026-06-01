-- project_members: accepted team memberships
create table public.project_members (
  id         uuid        primary key default gen_random_uuid(),
  project_id uuid        not null references public.projects(id) on delete cascade,
  user_id    uuid        not null references public.profiles(id) on delete cascade,
  invited_by uuid        not null references public.profiles(id),
  created_at timestamptz not null default now(),
  unique(project_id, user_id)
);

alter table public.project_members enable row level security;

create policy "project_members owner all"
  on public.project_members for all
  using  (exists(select 1 from public.projects where id = project_id and owner_id = auth.uid()))
  with check (exists(select 1 from public.projects where id = project_id and owner_id = auth.uid()));

create policy "project_members self read"
  on public.project_members for select
  using (user_id = auth.uid());

-- project_invitations: pending email invitations
create table public.project_invitations (
  id          uuid        primary key default gen_random_uuid(),
  project_id  uuid        not null references public.projects(id) on delete cascade,
  email       text        not null,
  token       text        not null unique default encode(gen_random_bytes(32), 'hex'),
  invited_by  uuid        not null references public.profiles(id),
  expires_at  timestamptz not null default (now() + interval '7 days'),
  accepted_at timestamptz,
  created_at  timestamptz not null default now(),
  unique(project_id, email)
);

alter table public.project_invitations enable row level security;

create policy "project_invitations owner all"
  on public.project_invitations for all
  using  (exists(select 1 from public.projects where id = project_id and owner_id = auth.uid()))
  with check (exists(select 1 from public.projects where id = project_id and owner_id = auth.uid()));

-- team members can also read projects they belong to
create policy "projects member read"
  on public.projects for select
  using (
    exists(select 1 from public.project_members where project_id = id and user_id = auth.uid())
  );
