drop index if exists public.audits_recent_listed_public_idx;

create index if not exists audits_recent_listed_public_idx
  on public.audits(completed_at desc)
  where listed_public = true
    and status = 'complete'
    and share_token is not null;
