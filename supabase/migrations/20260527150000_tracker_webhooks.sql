-- Per-project Stats tracker webhooks. Each project can register N webhook
-- URLs; /api/track fans out every event to every enabled webhook for the
-- project. Secret is plaintext (used both as HMAC key for Standard
-- Webhooks signing and as a bearer token receivers can optionally check),
-- mirroring lx_site.webhook_secret.

create table if not exists public.tracker_webhooks (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  url text not null,
  secret text not null,
  description text,
  enabled boolean not null default true,
  last_delivery_at timestamptz,
  last_response_code int,
  last_error text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, url)
);

create index if not exists tracker_webhooks_project_enabled_idx
  on public.tracker_webhooks(project_id) where enabled;

alter table public.tracker_webhooks enable row level security;

create policy "tracker_webhooks owner select"
  on public.tracker_webhooks for select
  using (
    project_id in (select id from public.projects where owner_id = auth.uid())
  );

create policy "tracker_webhooks owner insert"
  on public.tracker_webhooks for insert
  with check (
    project_id in (select id from public.projects where owner_id = auth.uid())
  );

create policy "tracker_webhooks owner update"
  on public.tracker_webhooks for update
  using (
    project_id in (select id from public.projects where owner_id = auth.uid())
  )
  with check (
    project_id in (select id from public.projects where owner_id = auth.uid())
  );

create policy "tracker_webhooks owner delete"
  on public.tracker_webhooks for delete
  using (
    project_id in (select id from public.projects where owner_id = auth.uid())
  );
