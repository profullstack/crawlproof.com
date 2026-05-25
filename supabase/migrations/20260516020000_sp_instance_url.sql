-- Per-instance fields for federated platforms (Mastodon today;
-- Bluesky custom PDS later). Mastodon also needs per-instance
-- registered app credentials since we register a Crawlproof app on
-- each new instance dynamically.

-- ============================================================
-- sp_account.instance_url
-- ============================================================
-- For Mastodon: "https://mastodon.social" — required to know which
-- host to call. For Bluesky: stays NULL (defaults to bsky.social in
-- code). Required-vs-null is platform-specific, enforced at the
-- application layer to keep the schema simple.
alter table public.sp_account
  add column if not exists instance_url text;

-- ============================================================
-- sp_mastodon_app — per-instance OAuth client credentials
-- ============================================================
-- Mastodon is federated: each instance is its own OAuth provider.
-- When a user first connects an account on a new instance, we
-- register a Crawlproof app there via POST /api/v1/apps and cache
-- the returned client_id + client_secret for reuse by every future
-- user connecting to the same instance.
--
-- client_secret is AES-GCM-encrypted at rest using SOCIAL_VAULT_KEY
-- (same envelope as sp_account.enc_*).
create table if not exists public.sp_mastodon_app (
  instance_url text primary key,
  client_id text not null,
  enc_client_secret text not null,
  redirect_uri text not null,
  created_at timestamptz not null default now()
);

-- Read by service role only — never exposed to clients directly.
alter table public.sp_mastodon_app enable row level security;
-- No policies = deny everything to anon/authenticated. Worker /
-- OAuth callback runs as service role and bypasses RLS.
