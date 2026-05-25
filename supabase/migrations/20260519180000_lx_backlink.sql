-- Phase 3 — Link Exchange ledger.
-- Append-only record of every cross-site backlink the matcher places.
-- Each row pins (giver site, giver article, target site, target article,
-- final URL + anchor). The matcher uses these later for fair-share
-- ranking; for now we just record.
create table if not exists public.lx_backlink (
  id uuid primary key default gen_random_uuid(),
  giver_site_id uuid not null references public.lx_site(id) on delete cascade,
  giver_article_id uuid not null references public.lx_article(id) on delete cascade,
  receiver_site_id uuid not null references public.lx_site(id) on delete cascade,
  receiver_article_id uuid references public.lx_article(id) on delete set null,
  target_url text not null,
  anchor text,
  created_at timestamptz not null default now()
);

create index if not exists lx_backlink_receiver_idx
  on public.lx_backlink(receiver_site_id, created_at desc);
create index if not exists lx_backlink_giver_idx
  on public.lx_backlink(giver_site_id, created_at desc);
create index if not exists lx_backlink_article_idx
  on public.lx_backlink(giver_article_id);

alter table public.lx_backlink enable row level security;

-- Owners can read their own outgoing + incoming backlinks via either side.
create policy "lx_backlink read via owned giver"
  on public.lx_backlink for select
  using (
    exists (
      select 1 from public.lx_site s
      where s.id = giver_site_id and s.user_id = auth.uid()
    )
  );

create policy "lx_backlink read via owned receiver"
  on public.lx_backlink for select
  using (
    exists (
      select 1 from public.lx_site s
      where s.id = receiver_site_id and s.user_id = auth.uid()
    )
  );
