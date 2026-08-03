-- Careers widget: an opt-in module of the drop-in tracker (/stats.js).
-- Customers already paste the stats snippet; flipping careers_enabled makes
-- that same snippet lazy-load /careers.js, which paints a job board plus an
-- inline three-field application form on their own /careers page.
--
-- Jobs are managed per project from the dashboard (Stats → Careers). Nothing
-- here is served unless the project has BOTH tracker_enabled and
-- careers_enabled — the widget is a tracker module, not a standalone product.

-- Per-project opt-in, mirroring tracker_enabled. Defaults off.
alter table public.projects
  add column if not exists careers_enabled boolean not null default false;

alter table public.projects
  add column if not exists careers_enabled_at timestamptz;

create index if not exists projects_careers_enabled_idx
  on public.projects(careers_enabled) where careers_enabled;

-- ── job_postings ─────────────────────────────────────────────────────────
-- One row per open role. `slug` is the public identifier used in the hosted
-- canonical URL (/c/<project_id>/<slug>) so a job keeps a stable, crawlable
-- address even as the title is edited.
create table if not exists public.job_postings (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null,
  slug text not null,
  title text not null,
  department text,
  location text,
  employment_type text not null default 'Full-time',
  -- Where the work happens. Distinct from employment_type, and worth three
  -- values rather than a remote boolean: "hybrid" is the case a boolean
  -- forces you to misreport, and it changes the schema.org output.
  workplace text not null default 'onsite'
    check (workplace in ('remote', 'hybrid', 'onsite')),
  compensation text,
  apply_url text,
  overview text,
  -- Rendered as bulleted lists in the widget, matching the reference layout.
  responsibilities text[] not null default '{}',
  qualifications text[] not null default '{}',
  status text not null default 'draft' check (status in ('draft', 'open', 'closed')),
  sort_order int not null default 0,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, slug)
);

create index if not exists job_postings_project_status_idx
  on public.job_postings(project_id, status, sort_order, created_at desc);

alter table public.job_postings enable row level security;

-- Owner policies and member policies sit side by side (RLS OR's them):
-- is_project_editor covers explicit project members and org members, but not
-- a solo project owner, so both are needed — same pairing tracker_integrations
-- uses.
create policy "job_postings owner select"
  on public.job_postings for select
  using (project_id in (select id from public.projects where owner_id = auth.uid()));

create policy "job_postings owner insert"
  on public.job_postings for insert
  with check (project_id in (select id from public.projects where owner_id = auth.uid()));

create policy "job_postings owner update"
  on public.job_postings for update
  using  (project_id in (select id from public.projects where owner_id = auth.uid()))
  with check (project_id in (select id from public.projects where owner_id = auth.uid()));

create policy "job_postings owner delete"
  on public.job_postings for delete
  using (project_id in (select id from public.projects where owner_id = auth.uid()));

create policy "job_postings member select"
  on public.job_postings for select
  using (public.is_project_editor(project_id, auth.uid()));

create policy "job_postings member insert"
  on public.job_postings for insert
  with check (public.is_project_editor(project_id, auth.uid()));

create policy "job_postings member update"
  on public.job_postings for update
  using  (public.is_project_editor(project_id, auth.uid()))
  with check (public.is_project_editor(project_id, auth.uid()));

create policy "job_postings member delete"
  on public.job_postings for delete
  using (public.is_project_editor(project_id, auth.uid()));

-- ── job_applications ─────────────────────────────────────────────────────
-- Three fields and a link — deliberately no resume upload, so we never take
-- custody of a file and the widget stays a single small script.
-- Written by /api/careers/apply via the service role; read by project members.
create table if not exists public.job_applications (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  job_id uuid not null references public.job_postings(id) on delete cascade,
  full_name text not null,
  email text not null,
  link text,
  note text,
  -- Review pipeline: everything lands as 'new'; the reviewer moves it forward
  -- (shortlisted → accepted) or out (rejected).
  status text not null default 'new'
    check (status in ('new', 'shortlisted', 'accepted', 'rejected')),
  reviewed_at timestamptz,
  source_url text,
  referrer text,
  user_agent text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- One application per email per posting. /api/careers/apply upserts on this,
  -- so a double-submitted form updates the existing row instead of duplicating.
  -- Plain columns rather than lower(email): ON CONFLICT needs a constraint it
  -- can name, and the API lowercases the address before writing.
  constraint job_applications_job_email_key unique (job_id, email)
);

create index if not exists job_applications_project_created_idx
  on public.job_applications(project_id, created_at desc);

create index if not exists job_applications_job_idx
  on public.job_applications(job_id, created_at desc);

-- The inbox filters by status constantly (shortlist view, new-only view).
create index if not exists job_applications_project_status_idx
  on public.job_applications(project_id, status, created_at desc);

alter table public.job_applications enable row level security;

create policy "job_applications owner select"
  on public.job_applications for select
  using (project_id in (select id from public.projects where owner_id = auth.uid()));

create policy "job_applications owner update"
  on public.job_applications for update
  using  (project_id in (select id from public.projects where owner_id = auth.uid()))
  with check (project_id in (select id from public.projects where owner_id = auth.uid()));

create policy "job_applications owner delete"
  on public.job_applications for delete
  using (project_id in (select id from public.projects where owner_id = auth.uid()));

create policy "job_applications member select"
  on public.job_applications for select
  using (public.is_project_editor(project_id, auth.uid()));

create policy "job_applications member update"
  on public.job_applications for update
  using  (public.is_project_editor(project_id, auth.uid()))
  with check (public.is_project_editor(project_id, auth.uid()));

create policy "job_applications member delete"
  on public.job_applications for delete
  using (public.is_project_editor(project_id, auth.uid()));

-- No INSERT policy: applications arrive from the public widget through
-- /api/careers/apply, which uses the service role.

-- ── public read surface ──────────────────────────────────────────────────
-- The widget and the hosted board need open jobs for a project without a
-- session. A SECURITY DEFINER function keeps job_postings itself private
-- while exposing exactly the published columns, and only when the project
-- has the module switched on.
create or replace function public.public_job_postings(p_project_id uuid)
returns table (
  id uuid,
  slug text,
  title text,
  department text,
  location text,
  employment_type text,
  workplace text,
  compensation text,
  apply_url text,
  overview text,
  responsibilities text[],
  qualifications text[],
  published_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select j.id, j.slug, j.title, j.department, j.location, j.employment_type,
         j.workplace, j.compensation, j.apply_url, j.overview,
         j.responsibilities, j.qualifications, j.published_at
  from public.job_postings j
  join public.projects p on p.id = j.project_id
  where j.project_id = p_project_id
    and j.status = 'open'
    and p.careers_enabled
    and p.tracker_enabled
  order by j.sort_order, j.created_at desc
$$;

revoke all on function public.public_job_postings(uuid) from public;
grant execute on function public.public_job_postings(uuid) to anon, authenticated, service_role;
