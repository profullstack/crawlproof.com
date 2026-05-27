-- Project social feed autoposting.
--
-- sp_feed_config stores the source feed selected on a project's Social tab.
-- sp_feed_item records every discovered URL so old feed entries are not
-- reposted and new entries are posted only once.

do $$
declare
  c text;
begin
  for c in
    select con.conname
    from pg_constraint con
    join pg_class cls on cls.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = cls.relnamespace
    join pg_attribute att
      on att.attrelid = cls.oid
     and att.attnum = any(con.conkey)
    where con.contype = 'c'
      and nsp.nspname = 'public'
      and cls.relname = 'sp_post'
      and att.attname = 'source'
  loop
    execute format('alter table public.sp_post drop constraint %I', c);
  end loop;
end$$;

alter table public.sp_post
  add constraint sp_post_source_check
  check (source in ('autoblog','manual','rss','sitemap','api'));

create table if not exists public.sp_feed_config (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  feed_type text not null default 'sitemap'
    check (feed_type in ('sitemap','rss')),
  feed_url text,
  ignore_paths text[] not null default '{}',
  enabled boolean not null default true,
  last_checked_at timestamptz,
  last_success_at timestamptz,
  last_item_at timestamptz,
  status text not null default 'idle'
    check (status in ('idle','checking','ok','error')),
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists sp_feed_config_project_unique
  on public.sp_feed_config(project_id);
create index if not exists sp_feed_config_due_idx
  on public.sp_feed_config(enabled, last_checked_at)
  where enabled = true;

alter table public.sp_feed_config enable row level security;
create policy "sp_feed_config owner all"
  on public.sp_feed_config for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop trigger if exists sp_feed_config_set_updated_at on public.sp_feed_config;
create trigger sp_feed_config_set_updated_at
  before update on public.sp_feed_config
  for each row execute function public.lx_set_updated_at();

create table if not exists public.sp_feed_item (
  id uuid primary key default gen_random_uuid(),
  config_id uuid not null references public.sp_feed_config(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  url text not null,
  title text,
  published_at timestamptz,
  first_seen_at timestamptz not null default now(),
  posted_at timestamptz,
  status text not null default 'seen'
    check (status in ('seen','posted','failed','ignored')),
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists sp_feed_item_config_url_unique
  on public.sp_feed_item(config_id, url);
create index if not exists sp_feed_item_project_seen_idx
  on public.sp_feed_item(project_id, first_seen_at desc);

alter table public.sp_feed_item enable row level security;
create policy "sp_feed_item owner all"
  on public.sp_feed_item for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop trigger if exists sp_feed_item_set_updated_at on public.sp_feed_item;
create trigger sp_feed_item_set_updated_at
  before update on public.sp_feed_item
  for each row execute function public.lx_set_updated_at();
