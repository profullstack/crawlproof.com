-- Guest-post request tracking.
--
-- Today the "Generate this guest post" button is fire-and-forget into
-- the worker — the only durable evidence that a request happened is
-- the resulting lx_article row, which only appears 1–3 minutes later
-- after generation succeeds. That makes it impossible for the UI to
-- show "you already clicked this" or to let the user undo a click
-- before the article lands.
--
-- This table is the missing request entity. One row per
-- (author_site, target_site, topic) tuple, tracking the lifecycle
-- from click to landing.
--
-- Status flow:
--   queued     — inserted by /api/lx/guest-posts/generate, worker not yet started
--   generating — worker has begun generateGuestPost
--   generated  — article row created, article_id populated
--   failed     — worker returned ok=false; error_text holds the reason
--
-- Deletion: allowed in queued/generating/failed (UI "unclick"). Locked
-- once status='generated' — the article lives in lx_article and the
-- partner blog may already have it via webhook.

create table if not exists public.lx_guest_post_request (
  id uuid primary key default gen_random_uuid(),
  author_site_id uuid not null references public.lx_site(id) on delete cascade,
  target_site_id uuid not null references public.lx_site(id) on delete cascade,
  topic text not null,
  status text not null default 'queued'
    check (status in ('queued','generating','generated','failed')),
  article_id uuid references public.lx_article(id) on delete set null,
  error_text text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One open request per (author, target, topic). If the user clicks
-- the same topic twice, the API returns the existing row instead of
-- duplicating work. A failed request can be retried by deleting first.
create unique index if not exists lx_guest_post_request_unique
  on public.lx_guest_post_request(author_site_id, target_site_id, topic);

create index if not exists lx_guest_post_request_author_idx
  on public.lx_guest_post_request(author_site_id, created_at desc);

drop trigger if exists lx_guest_post_request_set_updated_at
  on public.lx_guest_post_request;
create trigger lx_guest_post_request_set_updated_at
  before update on public.lx_guest_post_request
  for each row execute function public.lx_set_updated_at();

alter table public.lx_guest_post_request enable row level security;

-- Author site owner can see/manage their own requests. Target is not
-- granted visibility — the partner only sees the eventual article.
create policy "lx_guest_post_request via owned author"
  on public.lx_guest_post_request for select
  using (
    exists (
      select 1 from public.lx_site s
      where s.id = author_site_id and s.user_id = auth.uid()
    )
  );

create policy "lx_guest_post_request insert by owned author"
  on public.lx_guest_post_request for insert
  with check (
    exists (
      select 1 from public.lx_site s
      where s.id = author_site_id and s.user_id = auth.uid()
    )
  );

create policy "lx_guest_post_request delete by owned author"
  on public.lx_guest_post_request for delete
  using (
    exists (
      select 1 from public.lx_site s
      where s.id = author_site_id and s.user_id = auth.uid()
    )
    and status <> 'generated'
  );
