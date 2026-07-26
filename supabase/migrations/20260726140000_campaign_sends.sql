-- Send log for one-off outbound campaigns.
--
-- Without this there is no record that an address was mailed, so re-running a
-- campaign silently mails everyone a second time. The unique index is the
-- actual guard — the application check is only an optimisation, and a
-- concurrent second run would race straight past it.

create table if not exists public.campaign_sends (
  id uuid primary key default gen_random_uuid(),
  campaign text not null,
  email text not null,
  subject text,
  sent_at timestamptz not null default now()
);

-- One send per address per campaign, enforced by the database.
create unique index if not exists campaign_sends_campaign_email_idx
  on public.campaign_sends (campaign, lower(trim(email)));

create index if not exists campaign_sends_sent_at_idx
  on public.campaign_sends (campaign, sent_at desc);

alter table public.campaign_sends enable row level security;

-- No policies: service-role only. This is an internal audit log of who we
-- mailed, not something anon or authenticated should ever read.

comment on table public.campaign_sends is
  'Audit log of outbound campaign sends. Unique on (campaign, email) so a '
  're-run cannot mail the same address twice. Service-role access only.';
