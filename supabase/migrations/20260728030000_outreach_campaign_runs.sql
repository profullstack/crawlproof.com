-- A log of what each campaign tick actually did.
--
-- Campaigns kept one string, last_run_note, overwritten every 15 minutes. So
-- a tick that errored was invisible the moment the next one ran, and there
-- was no way to answer "has this campaign ever found anything?" — which is
-- the first question anyone asks of an automation that appears to be idle.

create table if not exists public.outreach_campaign_runs (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.outreach_campaigns(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  ran_at timestamptz not null default now(),
  -- The one-line summary shown in the UI.
  summary text not null,
  discovered int not null default 0,
  scans_started int not null default 0,
  researched int not null default 0,
  drafted int not null default 0,
  sent int not null default 0,
  -- Full detail, so a failed run can be diagnosed after the fact rather than
  -- from a truncated summary.
  errors jsonb not null default '[]'::jsonb,
  skipped jsonb not null default '[]'::jsonb,
  awaiting_auth jsonb not null default '[]'::jsonb,
  -- Whether the run is worth the user's attention.
  ok boolean not null default true
);

create index if not exists outreach_campaign_runs_campaign_idx
  on public.outreach_campaign_runs(campaign_id, ran_at desc);

alter table public.outreach_campaign_runs enable row level security;

-- Reads go through the service client after a project access check, matching
-- the rest of the outreach tables. No browser-side writes: this is a record
-- of what the runner did, and it stays honest by being unwritable from a
-- session.
drop policy if exists "outreach_campaign_runs owner read" on public.outreach_campaign_runs;
create policy "outreach_campaign_runs owner read"
  on public.outreach_campaign_runs for select
  using (
    exists (
      select 1 from public.projects p
      where p.id = project_id and p.owner_id = auth.uid()
    )
  );

comment on table public.outreach_campaign_runs is
  'Per-tick history for outreach campaigns. last_run_note holds only the newest; this keeps the trail.';
