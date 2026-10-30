-- Paid creative experiments for advertiser campaigns.
--
-- Each test copies the campaign's current creative set into a control arm and
-- generates one or more text variants. Serving assigns a visitor to one arm for
-- the life of the test; impression and click rows already point at creatives,
-- so their existing IDs provide variant-level reporting without changing the
-- metering path.

create table if not exists public.ad_experiments (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.ad_campaigns(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null default 'Creative test',
  status text not null default 'draft'
    check (status in ('draft','running','paused','completed')),
  instruction text,
  variant_count integer not null check (variant_count between 2 and 5),
  credits_charged integer not null default 0 check (credits_charged >= 0),
  winner_variant_id uuid,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz
);

create index if not exists ad_experiments_campaign_created_idx
  on public.ad_experiments(campaign_id, created_at desc);

create table if not exists public.ad_experiment_variants (
  id uuid primary key default gen_random_uuid(),
  experiment_id uuid not null references public.ad_experiments(id) on delete cascade,
  campaign_id uuid not null references public.ad_campaigns(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  variant_key text not null,
  label text not null,
  is_control boolean not null default false,
  instruction text,
  created_at timestamptz not null default now(),
  unique (experiment_id, variant_key)
);

do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'ad_experiments_winner_variant_fk'
      and conrelid = 'public.ad_experiments'::regclass
  ) then
    alter table public.ad_experiments
      add constraint ad_experiments_winner_variant_fk
      foreign key (winner_variant_id)
      references public.ad_experiment_variants(id)
      on delete set null;
  end if;
end $$;

create index if not exists ad_experiment_variants_experiment_idx
  on public.ad_experiment_variants(experiment_id);

alter table public.ad_campaigns
  add column if not exists active_experiment_id uuid
    references public.ad_experiments(id) on delete set null,
  add column if not exists default_variant_id uuid
    references public.ad_experiment_variants(id) on delete set null;

alter table public.ad_creatives
  add column if not exists experiment_id uuid
    references public.ad_experiments(id) on delete cascade,
  add column if not exists variant_id uuid
    references public.ad_experiment_variants(id) on delete cascade;

create index if not exists ad_creatives_experiment_idx
  on public.ad_creatives(experiment_id, variant_id, format);

create index if not exists ad_impressions_creative_idx
  on public.ad_impressions(creative_id);

create index if not exists ad_clicks_creative_idx
  on public.ad_clicks(creative_id);

alter table public.ad_experiments enable row level security;
alter table public.ad_experiment_variants enable row level security;

drop policy if exists "own ad experiments" on public.ad_experiments;
create policy "own ad experiments" on public.ad_experiments
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

drop policy if exists "own ad experiment variants" on public.ad_experiment_variants;
create policy "own ad experiment variants" on public.ad_experiment_variants
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

-- Credits are charged before generating alternatives. This refund helper is
-- atomic so a failed provider/database write cannot race another credit spend.
create or replace function public.refund_credit(p_owner uuid, p_count int)
returns void
language sql security definer set search_path = public as $$
  update public.profiles
  set credits_balance = credits_balance + greatest(p_count, 0)
  where id = p_owner;
$$;

revoke all on function public.refund_credit(uuid, int) from public, anon, authenticated;
grant execute on function public.refund_credit(uuid, int) to service_role;

-- Aggregated results stay in PostgreSQL rather than returning a capped page of
-- impression/click rows to the dashboard. auth.uid() scopes the security
-- definer to the campaign owner, while ad creatives remain the attribution key.
create or replace function public.ad_experiment_variant_stats(p_experiment uuid)
returns table (variant_id uuid, impressions bigint, clicks bigint)
language sql stable security definer set search_path = public as $$
  select
    v.id as variant_id,
    (
      select count(*)
      from public.ad_creatives creative
      join public.ad_impressions impression on impression.creative_id = creative.id
      where creative.experiment_id = e.id
        and creative.variant_id = v.id
        and not coalesce(impression.duplicate, false)
    ) as impressions,
    (
      select count(*)
      from public.ad_creatives creative
      join public.ad_clicks click on click.creative_id = creative.id
      where creative.experiment_id = e.id
        and creative.variant_id = v.id
        and click.valid
    ) as clicks
  from public.ad_experiment_variants v
  join public.ad_experiments e on e.id = v.experiment_id
  where e.id = p_experiment
    and e.owner_id = auth.uid()
  order by v.created_at;
$$;

revoke all on function public.ad_experiment_variant_stats(uuid) from public, anon;
grant execute on function public.ad_experiment_variant_stats(uuid) to authenticated;
