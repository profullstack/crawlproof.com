-- Unify lx_site under projects so a "project" is the canonical
-- top-level-domain entity that all autoblog + autopost configuration
-- hangs off of.
--
-- Before: projects (SEO audits) and lx_site (autoblog) were parallel
-- entities for the same conceptual thing — fragmented site management,
-- two separate pickers, two separate dashboards.
--
-- After: projects is the parent; lx_site is 1:1 with projects for the
-- autoblog half. sp_site_account and sp_post get rekeyed on
-- project_id so social posts are project-scoped end-to-end.

-- ============================================================
-- 1. lx_site.project_id  (1:1 with projects)
-- ============================================================

alter table public.lx_site
  add column if not exists project_id uuid references public.projects(id) on delete cascade;

-- For each lx_site that has no matching project row, mint one. We
-- match on (owner_id, normalized url) to avoid duplicating projects
-- a user already created via the SEO-audit flow.
insert into public.projects (owner_id, name, url, schedule)
select
  s.user_id,
  coalesce(s.name, s.domain),
  s.url,
  'off'
from public.lx_site s
left join public.projects p
  on p.owner_id = s.user_id
 and lower(regexp_replace(p.url, '^https?://(www\.)?', '')) =
     lower(regexp_replace(s.url, '^https?://(www\.)?', ''))
where s.project_id is null
  and p.id is null;

-- Link every lx_site to its matching project.
update public.lx_site s
set project_id = p.id
from public.projects p
where s.project_id is null
  and p.owner_id = s.user_id
  and lower(regexp_replace(p.url, '^https?://(www\.)?', '')) =
      lower(regexp_replace(s.url, '^https?://(www\.)?', ''));

alter table public.lx_site
  alter column project_id set not null;

-- Enforce 1:1 — a project has at most one autoblog config.
alter table public.lx_site
  add constraint lx_site_project_id_unique unique (project_id);

create index if not exists lx_site_project_id_idx on public.lx_site(project_id);

-- ============================================================
-- 2. sp_site_account → project-keyed
-- ============================================================

alter table public.sp_site_account
  add column if not exists project_id uuid references public.projects(id) on delete cascade;

update public.sp_site_account sa
set project_id = s.project_id
from public.lx_site s
where sa.site_id = s.id
  and sa.project_id is null;

-- Drop the old unique (site_id, account_id) so we can drop site_id.
drop index if exists public.sp_site_account_unique;
drop index if exists public.sp_site_account_auto_idx;

alter table public.sp_site_account
  drop column site_id;

alter table public.sp_site_account
  alter column project_id set not null;

create unique index if not exists sp_site_account_unique
  on public.sp_site_account(project_id, account_id);
create index if not exists sp_site_account_auto_idx
  on public.sp_site_account(project_id, auto)
  where auto = true;

-- ============================================================
-- 3. sp_post.project_id  (alongside site_id during transition)
-- ============================================================
--
-- sp_post.site_id was already nullable (on delete set null); we leave
-- it in place so legacy writes don't break, and populate project_id
-- on every existing row. New writes should set project_id directly.

alter table public.sp_post
  add column if not exists project_id uuid references public.projects(id) on delete set null;

update public.sp_post p
set project_id = s.project_id
from public.lx_site s
where p.site_id = s.id
  and p.project_id is null;

create index if not exists sp_post_project_id_idx on public.sp_post(project_id);
