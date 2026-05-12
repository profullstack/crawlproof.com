-- CrawlProof initial schema
-- Run via Supabase CLI: `supabase db push`
-- All user-owned tables have RLS enabled.

create extension if not exists "pgcrypto";

-- ============================================================
-- profiles
-- ============================================================
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  display_name text,
  plan text not null default 'free' check (plan in ('free','pro','team')),
  stripe_customer_id text,
  monthly_audit_count int not null default 0,
  monthly_audit_reset_at timestamptz not null default (now() + interval '30 days'),
  retain_raw_html bool not null default true,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "profiles self read"
  on public.profiles for select
  using (auth.uid() = id);

create policy "profiles self update"
  on public.profiles for update
  using (auth.uid() = id);

-- Create a profile automatically on signup
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, display_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'full_name', new.email))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ============================================================
-- projects
-- ============================================================
create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  name text not null,
  url text not null,
  schedule text not null default 'off' check (schedule in ('off','weekly','monthly')),
  next_run_at timestamptz,
  is_public bool not null default false,
  created_at timestamptz not null default now()
);

create index if not exists projects_owner_idx on public.projects(owner_id);
create index if not exists projects_next_run_idx on public.projects(next_run_at) where schedule <> 'off';

alter table public.projects enable row level security;

create policy "projects owner all"
  on public.projects for all
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);

-- ============================================================
-- audits
-- ============================================================
create table if not exists public.audits (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete set null,
  owner_id uuid references public.profiles(id) on delete set null,
  target_url text not null,
  status text not null default 'queued' check (status in ('queued','running','complete','failed')),
  score int,
  summary jsonb not null default '{}'::jsonb,
  share_token text unique,
  completed_at timestamptz,
  failed_reason text,
  created_at timestamptz not null default now()
);

create index if not exists audits_owner_idx on public.audits(owner_id);
create index if not exists audits_project_idx on public.audits(project_id);
create index if not exists audits_status_idx on public.audits(status);
create index if not exists audits_share_token_idx on public.audits(share_token);

alter table public.audits enable row level security;

create policy "audits owner select"
  on public.audits for select
  using (auth.uid() = owner_id);

create policy "audits owner update"
  on public.audits for update
  using (auth.uid() = owner_id);

create policy "audits owner delete"
  on public.audits for delete
  using (auth.uid() = owner_id);

-- Anonymous audits get inserted by the service role only.

-- ============================================================
-- audit_findings
-- ============================================================
create table if not exists public.audit_findings (
  id uuid primary key default gen_random_uuid(),
  audit_id uuid not null references public.audits(id) on delete cascade,
  section text not null,
  check_key text not null,
  status text not null check (status in ('pass','warn','fail','unknown')),
  title text not null,
  detail text,
  evidence jsonb not null default '{}'::jsonb,
  priority int not null default 3 check (priority between 1 and 5),
  created_at timestamptz not null default now()
);

create index if not exists findings_audit_idx on public.audit_findings(audit_id);
create index if not exists findings_section_idx on public.audit_findings(audit_id, section);

alter table public.audit_findings enable row level security;

create policy "findings via owned audit"
  on public.audit_findings for select
  using (
    exists (
      select 1 from public.audits a
      where a.id = audit_id and a.owner_id = auth.uid()
    )
  );

-- ============================================================
-- audit_artifacts
-- ============================================================
create table if not exists public.audit_artifacts (
  id uuid primary key default gen_random_uuid(),
  audit_id uuid not null references public.audits(id) on delete cascade,
  kind text not null check (kind in ('raw_html','rendered_html','screenshot','pdf_report')),
  path text not null,
  bytes int,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists artifacts_audit_idx on public.audit_artifacts(audit_id);

alter table public.audit_artifacts enable row level security;

create policy "artifacts via owned audit"
  on public.audit_artifacts for select
  using (
    exists (
      select 1 from public.audits a
      where a.id = audit_id and a.owner_id = auth.uid()
    )
  );

-- ============================================================
-- usage_events
-- ============================================================
create table if not exists public.usage_events (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid references public.profiles(id) on delete set null,
  ip_hash text,
  kind text not null,
  audit_id uuid references public.audits(id) on delete set null,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists usage_owner_idx on public.usage_events(owner_id, created_at desc);
create index if not exists usage_ip_idx on public.usage_events(ip_hash, created_at desc);

alter table public.usage_events enable row level security;

create policy "usage owner select"
  on public.usage_events for select
  using (auth.uid() = owner_id);

-- ============================================================
-- api_keys (v1.1 — table here, unused for now)
-- ============================================================
create table if not exists public.api_keys (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  prefix text not null,
  hash text not null,
  last_used_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.api_keys enable row level security;

create policy "api_keys owner all"
  on public.api_keys for all
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);

-- ============================================================
-- Public report read via share_token (bypasses RLS through SECURITY DEFINER)
-- ============================================================
create or replace function public.get_public_audit(token text)
returns table (
  id uuid,
  target_url text,
  status text,
  score int,
  summary jsonb,
  completed_at timestamptz,
  created_at timestamptz
)
language sql security definer set search_path = public stable as $$
  select id, target_url, status, score, summary, completed_at, created_at
  from public.audits
  where share_token = token
  limit 1;
$$;

create or replace function public.get_public_findings(token text)
returns setof public.audit_findings
language sql security definer set search_path = public stable as $$
  select f.*
  from public.audit_findings f
  join public.audits a on a.id = f.audit_id
  where a.share_token = token;
$$;

grant execute on function public.get_public_audit(text) to anon, authenticated;
grant execute on function public.get_public_findings(text) to anon, authenticated;
