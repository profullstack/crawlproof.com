-- Per-project social posting profile. Drives the per-platform LLM
-- renderer (brand voice, tone, hashtag defaults, image cadence) so
-- autoposts don't all sound the same.

create table if not exists public.sp_project_config (
  project_id uuid primary key references public.projects(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  brand_voice text not null default '',
  tone text not null default 'casual'
    check (tone in ('casual','professional','witty','authoritative','friendly','playful','technical')),
  default_hashtags text[] not null default '{}',
  -- 0 = never include AI-generated images, N = include on roughly every
  -- Nth autopost. The cadence gate is per project to keep cost bounded
  -- and avoid the feed looking like AI spam.
  image_cadence int not null default 0 check (image_cadence >= 0 and image_cadence <= 50),
  custom_instructions text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.sp_project_config enable row level security;
create policy "sp_project_config owner all"
  on public.sp_project_config for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop trigger if exists sp_project_config_set_updated_at on public.sp_project_config;
create trigger sp_project_config_set_updated_at
  before update on public.sp_project_config
  for each row execute function public.lx_set_updated_at();

-- Cache per-platform LLM renders + image choice on the feed item so a
-- single LLM/image call is reused across the multi-sweep drain (an item
-- may take many sweeps to ship to every bound platform under throttle).
alter table public.sp_feed_item
  add column if not exists rendered_per_platform jsonb not null default '{}',
  add column if not exists image_url text,
  add column if not exists image_source text
    check (image_source is null or image_source in ('og','ai'));

-- Public bucket so social platforms can fetch the image by URL.
insert into storage.buckets (id, name, public)
values ('sp-images', 'sp-images', true)
on conflict (id) do nothing;

create policy "sp-images public read"
  on storage.objects for select
  using (bucket_id = 'sp-images');
