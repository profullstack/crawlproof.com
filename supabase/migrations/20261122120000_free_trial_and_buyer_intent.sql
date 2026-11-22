-- 30-day free trial of paid features (no card) + Buyer Intent watches.
--
-- Trial model: every account gets trial_ends_at = signup + 30 days and a trial
-- credit pool (trial_credits). consume_credit draws the trial pool first while
-- the trial is live, then the paid balance, so every credit-metered feature
-- (AI scans, lead runs, outreach, autoblog, Buyer Intent sweeps) works free
-- during the trial with a bounded cost. When the trial ends the pool is simply
-- ignored: nothing is charged, nothing renews, no card was ever taken.
-- Keep TRIAL_DAYS / TRIAL_CREDITS in lib/trial.ts in step with this file.

alter table public.profiles
  add column if not exists trial_ends_at timestamptz,
  add column if not exists trial_credits integer not null default 0;

-- Backfill: existing accounts keep whatever is left of their first 30 days.
-- Accounts older than that get an already-ended trial and a zero pool.
update public.profiles
set trial_ends_at = coalesce(created_at, now()) + interval '30 days',
    trial_credits = case when coalesce(created_at, now()) > now() - interval '30 days' then 300 else 0 end
where trial_ends_at is null;

alter table public.profiles alter column trial_ends_at set default (now() + interval '30 days');
alter table public.profiles alter column trial_credits set default 300;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  insert into public.profiles (id, email, display_name, credits_balance, trial_ends_at, trial_credits)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', new.email),
    3,
    now() + interval '30 days',
    300
  )
  on conflict (id) do nothing;
  return new;
end;
$function$;
revoke execute on function public.handle_new_user() from public, anon, authenticated;

-- Trial pool first (only while the trial is live), then the paid balance.
-- Atomic: one UPDATE, row-locked, succeeds only if the two together cover it.
create or replace function public.consume_credit(p_owner uuid, p_count integer default 1)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_id uuid;
begin
  if p_count <= 0 then return true; end if;
  update public.profiles p
  set trial_credits = p.trial_credits - least(p_count, case when p.trial_ends_at > now() then greatest(p.trial_credits, 0) else 0 end),
      credits_balance = p.credits_balance - (p_count - least(p_count, case when p.trial_ends_at > now() then greatest(p.trial_credits, 0) else 0 end))
  where p.id = p_owner
    and p.credits_balance + (case when p.trial_ends_at > now() then greatest(p.trial_credits, 0) else 0 end) >= p_count
  returning p.id into v_id;
  return v_id is not null;
end;
$function$;
revoke execute on function public.consume_credit(uuid, integer) from public, anon, authenticated;
grant execute on function public.consume_credit(uuid, integer) to service_role;

-- Trial columns are server-written only, like the rest of the money.
create or replace function public.profiles_pin_privileged_columns()
returns trigger
language plpgsql
set search_path to ''
as $function$
begin
    if current_user not in ('authenticated', 'anon') then
        return new;
    end if;

    if new.id                        is distinct from old.id
       or new.email                     is distinct from old.email
       or new.is_admin                  is distinct from old.is_admin
       or new.plan                      is distinct from old.plan
       or new.stripe_customer_id        is distinct from old.stripe_customer_id
       or new.credits_balance           is distinct from old.credits_balance
       or new.promo_credits             is distinct from old.promo_credits
       or new.ad_bonus_credits          is distinct from old.ad_bonus_credits
       or new.trial_ends_at             is distinct from old.trial_ends_at
       or new.trial_credits             is distinct from old.trial_credits
       or new.monthly_audit_count       is distinct from old.monthly_audit_count
       or new.monthly_audit_reset_at    is distinct from old.monthly_audit_reset_at
       or new.alert_serp_calls_used     is distinct from old.alert_serp_calls_used
       or new.alert_serp_calls_reset_at is distinct from old.alert_serp_calls_reset_at
       or new.perf_report_last_sent_at  is distinct from old.perf_report_last_sent_at
       or new.default_org_id            is distinct from old.default_org_id
       or new.created_at                is distinct from old.created_at
    then
        raise exception 'profiles: id, email, is_admin, plan, credits, trial, quotas and org are not client-writable'
            using errcode = '42501';
    end if;

    return new;
end;
$function$;
revoke all on function public.profiles_pin_privileged_columns() from public, anon, authenticated;

-- Monitor trials: a trial row is an active subscription that nobody paid for.
alter table public.monitor_subscriptions
  add column if not exists is_trial boolean not null default false;

-- ---------------------------------------------------------------------------
-- Buyer Intent: saved keyword/competitor watches and the ranked leads they find.

create table if not exists public.intent_watches (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  name text not null,
  sells text,
  keywords text[] not null default '{}',
  competitors text[] not null default '{}',
  negative_keywords text[] not null default '{}',
  sources text[] not null default '{}',
  cadence text not null default 'daily' check (cadence in ('daily', '4h', 'hourly')),
  min_score integer not null default 25,
  slack_webhook_url text,
  discord_webhook_url text,
  webhook_url text,
  webhook_secret text,
  email_digest boolean not null default true,
  active boolean not null default true,
  last_run_at timestamptz,
  next_run_at timestamptz not null default now(),
  last_error text,
  created_at timestamptz not null default now()
);
create index if not exists intent_watches_due on public.intent_watches (next_run_at) where active;
create index if not exists intent_watches_owner on public.intent_watches (owner_id);

create table if not exists public.intent_leads (
  id uuid primary key default gen_random_uuid(),
  watch_id uuid not null references public.intent_watches(id) on delete cascade,
  owner_id uuid not null references public.profiles(id) on delete cascade,
  source text not null,
  url text not null,
  title text not null default '',
  snippet text not null default '',
  posted_at timestamptz,
  score integer not null,
  tier text not null check (tier in ('hot', 'engage', 'monitor')),
  intent_kind text,
  competitor text,
  reasons text[] not null default '{}',
  decision_maker boolean not null default false,
  reply_draft text,
  status text not null default 'new' check (status in ('new', 'replied', 'dismissed')),
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  unique (watch_id, url)
);
create index if not exists intent_leads_owner_score on public.intent_leads (owner_id, created_at desc);

alter table public.intent_watches enable row level security;
alter table public.intent_leads enable row level security;

drop policy if exists "own intent watches" on public.intent_watches;
create policy "own intent watches" on public.intent_watches
  for select using (owner_id = auth.uid());
drop policy if exists "own intent leads" on public.intent_leads;
create policy "own intent leads" on public.intent_leads
  for select using (owner_id = auth.uid());
-- Writes go through server routes with the service role.
revoke insert, update, delete on public.intent_watches from anon, authenticated;
revoke insert, update, delete on public.intent_leads from anon, authenticated;
revoke all on public.intent_watches from anon;
revoke all on public.intent_leads from anon;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'crawlproof-intent-watches') then
    perform cron.unschedule('crawlproof-intent-watches');
  end if;
end $$;

select cron.schedule(
  'crawlproof-intent-watches',
  '*/15 * * * *',
  $$
  select net.http_post(
    url := (select value from public.cron_config where key = 'site_url') || '/api/cron/intent-watches',
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'x-cron-secret', (select value from public.cron_config where key = 'cron_secret')
    ),
    body := '{}'::jsonb
  );
  $$
);
