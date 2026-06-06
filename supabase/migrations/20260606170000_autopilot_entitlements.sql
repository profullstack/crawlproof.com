-- Autopilot subscriptions + per-project monthly entitlements.
--
-- Phase 1 of docs/ai-growth-autopilot-prd.md. Article generation should
-- consume included monthly articles first, then fall back to the existing
-- credit balance.

create table if not exists public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  plan text not null check (plan in ('autopilot', 'agency')),
  status text not null check (status in ('active', 'past_due', 'cancelled')),
  current_period_start timestamptz not null,
  current_period_end timestamptz not null,
  provider text not null default 'manual',
  provider_subscription_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists subscriptions_user_status_idx
  on public.subscriptions(user_id, status, current_period_end desc);

create unique index if not exists subscriptions_provider_subscription_unique
  on public.subscriptions(provider, provider_subscription_id)
  where provider_subscription_id is not null;

alter table public.subscriptions enable row level security;

create policy "subscriptions owner select"
  on public.subscriptions for select
  using ((select auth.uid()) = user_id);

create table if not exists public.project_entitlements (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  subscription_id uuid references public.subscriptions(id) on delete set null,
  period_start timestamptz not null,
  period_end timestamptz not null,
  articles_included integer not null default 30 check (articles_included >= 0),
  articles_used integer not null default 0 check (articles_used >= 0),
  prompts_included integer not null default 25 check (prompts_included >= 0),
  prompts_used integer not null default 0 check (prompts_used >= 0),
  fix_prs_included integer not null default 5 check (fix_prs_included >= 0),
  fix_prs_used integer not null default 0 check (fix_prs_used >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(project_id, period_start)
);

create index if not exists project_entitlements_subscription_idx
  on public.project_entitlements(subscription_id);
create index if not exists project_entitlements_project_period_idx
  on public.project_entitlements(project_id, period_start desc, period_end desc);

alter table public.project_entitlements enable row level security;

create policy "project_entitlements via owned project"
  on public.project_entitlements for select
  using (
    public.is_project_member(project_id, (select auth.uid()))
  );

drop trigger if exists subscriptions_set_updated_at on public.subscriptions;
create trigger subscriptions_set_updated_at
  before update on public.subscriptions
  for each row execute function public.lx_set_updated_at();

drop trigger if exists project_entitlements_set_updated_at on public.project_entitlements;
create trigger project_entitlements_set_updated_at
  before update on public.project_entitlements
  for each row execute function public.lx_set_updated_at();

-- Returns:
--   entitlement  included monthly article was consumed
--   credit       one existing credit was consumed
--   none         neither quota nor credit was available
create or replace function public.consume_article_generation(
  p_project uuid,
  p_owner uuid
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_entitlement uuid;
  v_profile uuid;
begin
  if not exists (
    select 1
    from public.projects p
    where p.id = p_project
      and p.owner_id = p_owner
  ) then
    return 'none';
  end if;

  update public.project_entitlements pe
  set articles_used = articles_used + 1
  where pe.id = (
    select pe2.id
    from public.project_entitlements pe2
    where pe2.project_id = p_project
      and now() >= pe2.period_start
      and now() < pe2.period_end
      and pe2.articles_used < pe2.articles_included
      and (
        pe2.subscription_id is null
        or exists (
          select 1
          from public.subscriptions s
          where s.id = pe2.subscription_id
            and s.user_id = p_owner
            and s.status = 'active'
            and now() >= s.current_period_start
            and now() < s.current_period_end
        )
      )
    order by pe2.period_start desc
    limit 1
  )
  returning pe.id into v_entitlement;

  if v_entitlement is not null then
    return 'entitlement';
  end if;

  update public.profiles
  set credits_balance = credits_balance - 1
  where id = p_owner
    and credits_balance >= 1
  returning id into v_profile;

  if v_profile is not null then
    return 'credit';
  end if;

  return 'none';
end;
$$;

grant execute on function public.consume_article_generation(uuid, uuid)
  to authenticated, service_role;

create or replace function public.refund_article_entitlement(
  p_project uuid,
  p_owner uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_entitlement uuid;
begin
  if not exists (
    select 1
    from public.projects p
    where p.id = p_project
      and p.owner_id = p_owner
  ) then
    return false;
  end if;

  update public.project_entitlements pe
  set articles_used = articles_used - 1
  where pe.id = (
    select pe2.id
    from public.project_entitlements pe2
    where pe2.project_id = p_project
      and now() >= pe2.period_start
      and now() < pe2.period_end
      and pe2.articles_used > 0
      and (
        pe2.subscription_id is null
        or exists (
          select 1
          from public.subscriptions s
          where s.id = pe2.subscription_id
            and s.user_id = p_owner
        )
      )
    order by pe2.period_start desc
    limit 1
  )
  returning pe.id into v_entitlement;

  return v_entitlement is not null;
end;
$$;

grant execute on function public.refund_article_entitlement(uuid, uuid)
  to authenticated, service_role;
