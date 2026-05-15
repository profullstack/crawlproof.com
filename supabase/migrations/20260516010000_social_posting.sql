-- Social posting Phase 1 — the schema layer.
--
-- Three tables, all sp_-prefixed:
--   sp_account         — user-scoped pool of connected social accounts
--   sp_site_account    — M:N binding from sites to accounts, with the
--                        `auto` flag for AI-driven publishing
--   sp_post            — queued + sent post log, per-account
--
-- See docs/social-posting-prd.md §3 for the full design and §6 for
-- the auto-mode pipeline. Bluesky ships first (Phase 1.1); other
-- platforms slot into the same tables.
--
-- Token encryption: Phase 1 uses static-key AES-GCM with a 256-bit
-- key from env (SOCIAL_VAULT_KEY). Migrating to envelope encryption
-- with per-user DEKs (Vault KEK + per-user data keys) is on the
-- roadmap for Phase 3 when password + cookie storage lands — for
-- OAuth bearers a single key is fine since the platform can revoke
-- a leaked token.

-- ============================================================
-- sp_account — the user's pool of connected social accounts
-- ============================================================
create table if not exists public.sp_account (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,

  platform text not null check (platform in (
    'bluesky','mastodon','reddit','linkedin','threads','pinterest','tumblr',
    'x','facebook_page','instagram_business','youtube',
    'tiktok','instagram','snapchat'
  )),

  -- 'oauth'     = bearer/OAuth2 token via the platform's official API
  --               (Bluesky's app-password flow lands here too — the
  --               resulting access JWT behaves like an OAuth token).
  -- 'cookie'    = browser automation with replayed session cookies.
  -- 'puppeteer' = browser automation with full username/password/TOTP.
  auth_mode text not null default 'oauth'
    check (auth_mode in ('oauth','cookie','puppeteer')),

  -- Display info shown in the picker.
  handle text not null,                            -- @chovy.bsky.social
  external_id text,                                -- did:plc:xxxxx or platform user id

  -- OAuth-mode tokens. Encrypted at rest with AES-GCM
  -- (base64-encoded nonce + ciphertext + auth tag in a single string).
  -- See lib/sp/vault.ts.
  enc_access_token text,
  enc_refresh_token text,
  token_expires_at timestamptz,

  -- Cookie-mode + Puppeteer-mode fields ship in Phase 3.
  enc_cookies text,
  cookies_acquired_at timestamptz,
  enc_username text,
  enc_password text,
  enc_2fa_seed text,

  -- Operational state.
  status text not null default 'active'
    check (status in ('active','token_expired','suspended_by_platform','user_disabled','flagged')),
  last_post_at timestamptz,
  consecutive_failures int not null default 0,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists sp_account_unique
  on public.sp_account(user_id, platform, external_id);
create index if not exists sp_account_user_idx on public.sp_account(user_id);

alter table public.sp_account enable row level security;
create policy "sp_account owner all"
  on public.sp_account for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ============================================================
-- sp_site_account — M:N binding sites to connected accounts
-- ============================================================
-- One account → many sites (an agency's "Acme LinkedIn" can post to
-- both acme.com and acme-product.com without re-connecting). One site
-- → many accounts (post to X + LinkedIn + Bluesky on every article).
--
-- The `auto` flag is the AI-publishing gate: when an autoblog article
-- publishes, we generate a per-platform post for each (site, account)
-- binding where auto=true and queue it as sp_post.
create table if not exists public.sp_site_account (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  site_id uuid not null references public.lx_site(id) on delete cascade,
  account_id uuid not null references public.sp_account(id) on delete cascade,
  auto boolean not null default false,
  render_overrides jsonb not null default '{}'::jsonb,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists sp_site_account_unique
  on public.sp_site_account(site_id, account_id);
create index if not exists sp_site_account_account_idx
  on public.sp_site_account(account_id);
create index if not exists sp_site_account_auto_idx
  on public.sp_site_account(site_id, auto)
  where auto = true and enabled = true;

alter table public.sp_site_account enable row level security;
create policy "sp_site_account owner all"
  on public.sp_site_account for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ============================================================
-- sp_post — queued + sent post log
-- ============================================================
create table if not exists public.sp_post (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  site_id uuid references public.lx_site(id) on delete set null,
  account_id uuid not null references public.sp_account(id) on delete cascade,

  source text not null default 'manual'
    check (source in ('autoblog','manual','rss','api')),
  autoblog_article_id uuid references public.lx_article(id) on delete set null,

  -- Per-platform rendered content. JSON because some platforms post
  -- as threads (array of items) and some as single strings.
  rendered_text text not null,
  rendered_media_url text[] not null default '{}',

  -- Threading (X threads, Bluesky threads, etc.). One sp_post per
  -- thread item; thread_root_id ties them together.
  thread_root_id uuid references public.sp_post(id) on delete set null,
  thread_position int,

  scheduled_for timestamptz not null,
  status text not null default 'queued'
    check (status in ('queued','publishing','published','failed','cancelled')),
  published_at timestamptz,
  platform_post_id text,
  platform_post_url text,
  publish_attempts int not null default 0,
  last_error text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists sp_post_account_queued_idx
  on public.sp_post(account_id, scheduled_for)
  where status = 'queued';
create index if not exists sp_post_user_status_idx
  on public.sp_post(user_id, status, scheduled_for);

alter table public.sp_post enable row level security;
create policy "sp_post owner all"
  on public.sp_post for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ============================================================
-- sp_publish_attempt — append-only audit log for support + triage
-- ============================================================
create table if not exists public.sp_publish_attempt (
  id bigserial primary key,
  post_id uuid not null references public.sp_post(id) on delete cascade,
  attempt_number int not null,
  outcome text not null check (outcome in ('success','retryable','permanent_fail')),
  http_status int,
  platform_error_code text,
  error_message text,
  auth_mode text,
  created_at timestamptz not null default now()
);
create index if not exists sp_publish_attempt_post_idx
  on public.sp_publish_attempt(post_id, attempt_number);

alter table public.sp_publish_attempt enable row level security;
-- Read-only to the post's owner (no INSERT/UPDATE from clients — worker only).
create policy "sp_publish_attempt via owned post"
  on public.sp_publish_attempt for select
  using (
    exists (
      select 1 from public.sp_post p
      where p.id = post_id and p.user_id = auth.uid()
    )
  );

-- ============================================================
-- updated_at trigger reuse — public.lx_set_updated_at() already
-- exists from migration 20260513090000_link_exchange_v1.sql.
-- ============================================================
drop trigger if exists sp_account_set_updated_at on public.sp_account;
create trigger sp_account_set_updated_at
  before update on public.sp_account
  for each row execute function public.lx_set_updated_at();

drop trigger if exists sp_site_account_set_updated_at on public.sp_site_account;
create trigger sp_site_account_set_updated_at
  before update on public.sp_site_account
  for each row execute function public.lx_set_updated_at();

drop trigger if exists sp_post_set_updated_at on public.sp_post;
create trigger sp_post_set_updated_at
  before update on public.sp_post
  for each row execute function public.lx_set_updated_at();
