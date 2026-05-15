# Crawlproof Social Posting — PRD

> Goal: a Buffer/Postiz-style scheduled social-posting layer inside crawlproof.com. Customer connects N social accounts → autoblog (or any other input we own) generates a post per platform → we publish on schedule. 1 credit per platform per post; same credit ledger we use for audits + autoblog. The differentiator vs. the dozen existing competitors is *we already write the content* — the customer doesn't have to copy/paste from another tool.
>
> This PRD predates implementation. No competitive recon yet — TODO: log into revid.ai / Postiz / Publer and capture their oauth flows + DB shape before we start.

---

## Status as of 2026-05-15

**Phase 0 — PRD: this document.**

**Phase 1 — OAuth-only platforms: PLANNED.**
- Reddit, Mastodon, Bluesky (AT Protocol), Threads, LinkedIn (Posts API), Pinterest, Tumblr.
- These have official, working content-publish APIs with bearer / OAuth2 tokens. Lowest legal + operational risk. First to ship.

**Phase 2 — Meta + X family: PLANNED.**
- Facebook Pages (Graph API, well-documented), Instagram Business (Graph API for image+video), YouTube Community (Data API v3), X via paid API tier.
- All require app review and platform-specific approval; treat as "ships when the review lands."

**Phase 3 — Browser-automation fallback: PLANNED, GATED.**
- For platforms that either (a) have no content-publish scope (Instagram personal, TikTok for non-approved apps, Snapchat) or (b) gate the API behind a long approval process we don't want to wait on.
- Higher operational + legal risk (most platforms' ToS forbid automation). Opt-in per customer with a real disclosure modal, isolated browser-runner cluster, residential proxies, encrypted credential vault.

---

## 1. Competitive landscape (planned recon)

Capture before build:

- **Buffer / Hootsuite** — the incumbents. Strong on OAuth coverage, expensive. They explicitly *do not* do browser automation.
- **Postiz** ([github.com/gitroomhq/postiz-app](https://github.com/gitroomhq/postiz-app)) — open-source competitor. Their `apps/backend/src/services/integrations/social/` is a goldmine for OAuth flow specifics per platform.
- **Publer / SocialBee** — affordable, OAuth-only, no browser automation.
- **Hypefury** — X-focused, official API.
- **revid.ai** (relevant later for §2 video PRD) — does TikTok + Reels + Shorts posting; worth seeing whether they're API or browser-automation.

What we want from recon:
- Exact OAuth scopes each platform requires for posting (most lock content-publish behind a higher-tier scope).
- Rate limits per platform (some are stunningly tight — X free tier was 17 posts/day before paid was required).
- Token refresh cadence (some are 60 days, some are 1 hour).
- What "posting" actually means per platform (text+image vs text-only vs video-only).

---

## 2. The Crawlproof version — scope

### 2.1 Positioning
- Sold as an **add-on** inside crawlproof.com, like Autoblog.
- Tightly integrated with Autoblog: an autoblogged article can automatically generate per-platform social posts (LinkedIn long-form, X thread, Bluesky post, etc.) sharing the article URL. **This is the wedge** — we're the only tool that owns both ends.
- One *customer account* → N *connected social accounts*. A customer can have e.g. their personal X + their company X + their Bluesky + their LinkedIn personal + their company LinkedIn page, all on one Crawlproof bill.

### 2.2 What we keep + what we drop vs. competitors

| | Postiz / Buffer | Crawlproof v1 |
|---|---|---|
| Direct OAuth (X, LinkedIn, Reddit, Mastodon, Bluesky, Threads, Pinterest, Tumblr, Meta Pages/IG Biz, YouTube) | ✓ | ✓ |
| Browser-automation fallback (Instagram personal, TikTok, Snapchat) | ✗ | ✓ (gated, opt-in) |
| Generate the post text from scratch | ✗ | ✓ (Claude Sonnet 4.6, per-platform style) |
| Auto-tie a social post to an autoblog article | ✗ | ✓ |
| Threaded posts (X threads, LinkedIn carousels, Bluesky threads) | partial | ✓ |
| Image generation (gpt-image-1) per post | ✗ | ✓ |
| Schedule calendar UI w/ drag-drop | ✓ | v1: list. v2: drag-drop. |
| Analytics dashboard | ✓ | v1: post-send confirmation + last-known-status. v2: deeper. |

---

## 3. Data model (Supabase)

New tables, all prefixed `sp_`.

```sql
-- A user's connected social account on one platform.
create table sp_account (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  platform text not null check (platform in (
    'x','linkedin','reddit','mastodon','bluesky','threads','pinterest','tumblr',
    'facebook_page','instagram_business','youtube','tiktok','instagram','snapchat'
  )),
  -- 'oauth' = bearer/OAuth2 token via that platform's official API.
  -- 'puppeteer' = browser automation with stored credentials.
  auth_mode text not null check (auth_mode in ('oauth','puppeteer')),
  -- Display name shown in the UI ("@chovy", "Crawlproof on LinkedIn").
  handle text not null,
  -- Platform's own ID for this account (X user_id, etc.) — for dedupe + analytics.
  external_id text,
  -- OAuth tokens (encrypted at rest via Supabase Vault).
  access_token text,                              -- vault.create_secret returns the key
  refresh_token text,                             -- same
  token_expires_at timestamptz,
  -- Puppeteer credentials (envelope-encrypted with the user's master DEK).
  enc_username bytea,
  enc_password bytea,
  enc_2fa_seed bytea,                             -- if user provides TOTP seed
  -- Operational state.
  status text not null default 'active'
    check (status in ('active','token_expired','suspended_by_platform','user_disabled','flagged')),
  last_post_at timestamptz,
  consecutive_failures int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index on sp_account(user_id, platform, external_id);

-- A queued or sent post. One row per (platform target, scheduled-time) pair.
create table sp_post (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  account_id uuid not null references sp_account(id) on delete cascade,
  -- Source of truth for the content. Either crawlproof-generated or user-paste.
  source text not null check (source in ('autoblog','manual','rss','api')),
  -- If from autoblog, link back to the article.
  autoblog_article_id uuid references lx_article(id) on delete set null,
  -- Per-platform rendering (X has 280-char cap, LinkedIn has 3,000, Bluesky 300, etc.).
  rendered_text text not null,
  rendered_media_url text[] not null default '{}',
  -- Threaded posts: each row is one tweet; thread_root_id ties them together.
  thread_root_id uuid references sp_post(id) on delete set null,
  thread_position int,
  -- Scheduling.
  scheduled_for timestamptz not null,
  -- Lifecycle.
  status text not null default 'queued'
    check (status in ('queued','publishing','published','failed','cancelled')),
  published_at timestamptz,
  platform_post_id text,                          -- platform's own ID after publish
  platform_post_url text,                         -- for the "view post" link in UI
  publish_attempts int not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on sp_post(account_id, scheduled_for) where status = 'queued';
create index on sp_post(user_id, status, scheduled_for);

-- Append-only audit log of every publish attempt (for support + abuse review).
create table sp_publish_attempt (
  id bigserial primary key,
  post_id uuid not null references sp_post(id) on delete cascade,
  attempt_number int not null,
  outcome text not null check (outcome in ('success','retryable','permanent_fail')),
  http_status int,
  platform_error_code text,
  error_message text,
  -- Was this attempt OAuth or browser-automation? Useful for triage.
  auth_mode text,
  created_at timestamptz not null default now()
);
create index on sp_publish_attempt(post_id, attempt_number);
```

RLS: all rows scoped through `user_id`.

---

## 4. Per-platform OAuth + scope matrix

Documented in code as `lib/sp/platforms.ts`. Below is the v1 target list with realism notes.

| Platform | OAuth supports posting? | Required scope | Approval process | Rate limit (free) | Notes |
|---|---|---|---|---|---|
| **Reddit** | ✓ | `submit` | None (instant app key) | ~60/min | Cleanest. Ship first. |
| **Mastodon** | ✓ | `write:statuses` | None (per-instance) | per-instance | Federated; we'd let the user paste their instance URL. |
| **Bluesky** | ✓ | n/a (AT Protocol app password) | None | generous | App-password auth, not OAuth. Easy. |
| **Threads** | ✓ | `threads_content_publish` | Meta app review | tight | Same review as IG. |
| **LinkedIn** | ✓ | `w_member_social` | Self-serve | 100/day | Reliable. |
| **Pinterest** | ✓ | `boards:write,pins:write` | Self-serve | ~1000/day | OK. |
| **Tumblr** | ✓ | `write` | Self-serve | generous | Niche but cheap to add. |
| **Facebook Page** | ✓ | `pages_manage_posts,pages_read_engagement` | Meta app review | generous | Pages only — NOT personal feed. |
| **Instagram Business** | ✓ | `instagram_content_publish` | Meta app review | tight | Business/Creator accounts only. |
| **YouTube Community** | ✓ | `youtube.force-ssl` | App verification | ~10k units/day | Quota math is nontrivial. |
| **X** | partial | `tweet.write` | Paid Basic ($200/mo) | 50/day (Basic) | Free tier won't support a real product. Hard call. |
| **TikTok** | ✓ for approved apps | `video.upload,video.publish` | App review (slow, often denied) | tight | Critical for §2 video PRD. Block on approval. |
| **Instagram personal** | ✗ | — | — | — | Puppeteer-only. |
| **Snapchat** | ✗ for unapproved | — | — | — | Puppeteer-only or skip. |

---

## 5. Browser-automation fallback (Phase 3)

**This is the heavy section.** Doing it right is hard; doing it sloppy is dangerous (to customer accounts and to us as ToS violators). PRD captures the design *and* the case for keeping it small.

### 5.1 When we use it

A platform falls into the Puppeteer path iff *both*:
- It has no OAuth content-publish scope (Instagram personal, TikTok if not approved, Snapchat).
- The customer has explicitly opted in via a disclosure modal that says: "We will log into your account from a server. Most platforms forbid this in their Terms of Service. If your account is banned, that's on the platform, not on us."

### 5.2 Credential vault

**Encryption model: envelope encryption with two keys.** "Encrypt with our private key" (the user's phrasing in the task) is too vague to ship — what we actually need:

1. **Per-user DEK** (data encryption key): a 256-bit AES key, one per Crawlproof user, stored encrypted under a KEK.
2. **KEK** (key-encrypting key): managed by Supabase Vault (or KMS if we outgrow Vault). The KEK never leaves the secure boundary.
3. To encrypt the user's IG password: pull DEK, encrypt the password with AES-GCM, store ciphertext + nonce in `sp_account.enc_password`. The DEK is re-encrypted under KEK so the at-rest DB column never contains plaintext.
4. To decrypt for use: the worker calls Vault to unwrap the DEK, decrypts the password just-in-time, uses it in the headless browser session, then discards from memory.

This is industry-standard and what every credential-stashing product (1Password, Vault, Doppler) does. The naive "encrypt with our private key" model (asymmetric, one keypair for all users) is what gets companies in TechCrunch articles when one server compromise pops every credential.

### 5.3 Browser-runner cluster

Each user-platform combo gets its own isolated Playwright context:

- **Per-user residential proxies** (Bright Data / Soax / etc.). Logging in from a datacenter IP is the #1 detection signal. Approx $0.50/GB residential. Per-customer per-month cost varies; a typical IG post needs ~50 MB of traffic, so $0.025 per post. Adds to COGS.
- **Persistent user-data dirs** keyed by `(user_id, platform)`. Reuse cookies + local storage across runs so we don't trigger "new device" challenges on every login.
- **Fingerprint stability**: each (user_id, platform) gets a stable user-agent, screen size, timezone, language. Fingerprint rotation kills login flows.
- **2FA handling**: if the user provides a TOTP seed, we generate the code at login time. If they don't, we prompt them via a modal that asks them to enter the code from their authenticator (and queue the post for 2 minutes later).
- **CAPTCHA**: 2Captcha / Anti-Captcha integration. ~$0.001/solve. Build assumes 5% of logins hit a CAPTCHA.

### 5.4 What can go wrong (and why we keep it small)

- **Account bans.** Platforms detect server-side login from residential IPs eventually. Expected attrition: ~5%/month of accounts get challenged or banned. Disclosure modal MUST make this clear.
- **2FA push notifications.** Some platforms now require a phone-tap to approve new logins. If the user doesn't have TOTP, we get stuck.
- **Platform UI changes.** Every IG redesign breaks our selectors. Need a regression test that runs once per day and pages the on-call when it fails.
- **Legal**: most platforms' ToS forbid automation. We are not the user; we are an agent posting on their behalf. The legal theory we'd rely on is that the *user* directed us — but platforms sometimes treat the agent and the user as one party for enforcement. **Real lawyer review before this ships.**

---

## 6. AI generation pipeline

When the source is `autoblog`, an article publishing → one `sp_post` row per connected account, per-platform-rendered:

- **X (≤ 280 chars)**: thread of 3–6 tweets. Hook tweet → 2–4 substance tweets → CTA tweet linking the article. Claude Sonnet 4.6 with the operator-voice prompt narrowed to social-thread mode.
- **LinkedIn (≤ 3,000 chars)**: single long-form post. Strong opening line, scannable body, no link-in-comments BS (LinkedIn now ranks posts with links fine). Claude Sonnet 4.6.
- **Bluesky (≤ 300 chars)**: single post or short thread.
- **Mastodon**: respects per-instance char cap (default 500).
- **Threads**: similar to X but no thread support yet (single 500-char post).
- **Reddit**: title-and-link post to a user-specified subreddit. Auto-suggest subreddit from the article's tags + niche.
- **Pinterest**: pin with the article's hero image + meta description as the body + link.
- **Facebook Page / IG Business**: image post (article hero) + first 150 chars + link.

Each platform has its own prompt template in `lib/sp/render.ts`. The schema validates per-platform constraints before save.

---

## 7. Worker jobs

Reuse `worker/index.ts`. New jobs:

| Job | Schedule | Purpose |
|---|---|---|
| `sp.oauth.refresh` | every 10 min | Find tokens within 1h of expiry and refresh via the platform's refresh endpoint. |
| `sp.publish.tick` | every 60 sec | Find `sp_post` rows with `scheduled_for <= now()` and `status='queued'`, claim atomically, dispatch to the platform-specific publisher. |
| `sp.puppeteer.publish` | invoked by tick | One isolated Playwright session per call. Login → post → confirm → close. |
| `sp.account.health` | hourly | For each `auth_mode='puppeteer'` account, run a no-op "is the session still valid" check (load the profile page). On fail: mark `token_expired`, email the user. |

---

## 8. UI surface (Next.js, under `app/(app)/social/`)

| Route | Shows |
|---|---|
| `/social/setup` | "Connect an account" wall. Lists every supported platform with a green-check / "Connect" button. Disclosure modal for Puppeteer-mode platforms. |
| `/social` | Dashboard: connected accounts (avatar, status, last-post-at), upcoming queue (next 7 days), recent posts. |
| `/social/compose` | Manual compose: pick a platform → write text (with per-platform char counter and live preview) → schedule. |
| `/social/queue` | All queued posts in list form. v2 = drag-drop calendar. |
| `/social/post/[id]` | Single post detail: per-platform attempt log, retry button on failed ones. |

---

## 9. API surface (Next.js route handlers)

All under `app/api/sp/`:

- `POST /api/sp/account/oauth-start?platform=x` — kicks off the OAuth dance.
- `GET  /api/sp/account/oauth-callback` — handles the callback, persists tokens.
- `POST /api/sp/account/puppeteer` — body: `{ platform, username, password, totp_seed? }`. Encrypts + stores.
- `DELETE /api/sp/account/{id}` — disconnects.
- `POST /api/sp/post` — schedule a new post (or thread).
- `GET  /api/sp/queue` — paginated list of queued posts.
- `POST /api/sp/post/{id}/retry` — retry a failed post.
- `POST /api/sp/post/{id}/cancel` — cancel a queued one.

Internal (cron-secret gated):
- `POST /api/sp/internal/refresh-tokens`
- `POST /api/sp/internal/publish-tick`

---

## 10. Pricing model

**1 credit per platform per scheduled post.** Mirrors autoblog (1 credit per article published).

| Event | Credits |
|---|---|
| Single post lands on one platform | 1 |
| Thread of 5 posts on one platform | 1 (the whole thread is one logical post) |
| One autoblog article fanning out to 5 connected platforms | 5 |
| OAuth token refresh | 0 |
| Cancelled / never-published post | 0 (refunded at cancel time) |

COGS realism:
- OAuth posts: ~$0 marginal cost (we already pay for the worker + DB). Profitable at any sane credit price.
- Puppeteer posts: ~$0.025/post in residential-proxy bandwidth, ~$0.001/post amortized for CAPTCHA solves, ~$0.001/post for headless browser cluster compute. Total ~$0.03/post. At $0.20–$0.30 per credit, healthy margin.
- 2FA-required reconnects: ~$0 marginal cost (we just email the user).

---

## 11. Risks & mitigations

- **Platform bans for browser automation.** Disclosure modal + per-account opt-in + clear audit log of "I told you so." Soft-cap a user's puppeteer-platform account count at 2 in v1 so we limit blast radius.
- **Credential leak.** Envelope encryption with KMS-managed KEK (see §5.2). Penetration test before Phase 3 ships.
- **Token expiry while user is on vacation.** `sp.oauth.refresh` runs every 10 min and emails the user when a refresh fails permanently (i.e. they revoked our app).
- **Per-platform rate limits exhausting at 11pm.** Each `sp_account` row carries a per-day post counter; tick job respects platform-specific caps and defers excess to next day.
- **Spam / abuse reports.** If a `sp_account` receives N spam reports in a window, flag the *user* (not just the account) for review. Coordinated abuse across multiple connected accounts is a strong signal.
- **Auto-deletes on the platform side.** E.g. X mass-deleting via their spam classifier. We don't try to fight this; we just log it via `sp_publish_attempt.outcome='success'` followed by a verification crawler showing the post is gone.

---

## 12. Out of scope for v1

- Drag-drop calendar UI (v2)
- Cross-posting analytics (impressions, clicks, engagement) — relies on platform metric APIs which are gated separately
- AI auto-reply to comments
- DM automation (NOPE)
- Boosting / paid promotion
- Multi-team workspaces (one user owns all accounts; team invites later)
- Approval workflows ("editor approves before publish")

---

## 13. Build sequence

1. **Migration** — `supabase/migrations/NNNN_social_posting.sql` (§3).
2. **Encryption module** — `lib/sp/vault.ts`. Uses Supabase Vault for KEK; DEK is per-user. Tests: round-trip a password through encrypt/decrypt.
3. **OAuth platforms**, fastest first:
   1. Reddit (1 day)
   2. Bluesky (1 day, app password not OAuth)
   3. Mastodon (1 day)
   4. LinkedIn (2 days, real review process)
   5. Pinterest, Tumblr (1 day each)
4. **Per-platform rendering prompts** — `lib/sp/render.ts`. Tied to the autoblog article pipeline so a new article automatically fans out.
5. **Worker tick + publish dispatch** — `worker/sp/publish.ts`.
6. **Dashboard + setup UI** — three routes (§8).
7. **Meta family** — once app review lands.
8. **X** — once the user agrees to the $200/mo API tier.
9. **Puppeteer fallback** — last. Behind a `puppeteer_enabled` flag on the user's profile; ships dark until lawyer-reviewed.

---

## 14. Open questions for before build

- **Lawyer review on browser-automation ToS exposure.** Specifically: are we liable if a customer's account gets banned because we logged in on their behalf? US case law leans "the user gave us permission so it's fine"; platform ToS lean "no it's not."
- **Browser cluster vendor choice.** Browserless / Browserbase / self-host Playwright on Railway? Each has different security + cost profiles for the credential-decryption path.
- **Proxy vendor.** Bright Data is the gold standard; Soax / Smartproxy are cheaper. Need to test detection rates per platform.
- **Image strategy on social posts.** Reuse the autoblog hero image, or generate a per-platform 16:9 / 1:1 / 9:16 variant via gpt-image-1 (~$0.04 each, meaningful at scale)?
- **Threading on Bluesky / Mastodon.** Both support threads natively. The autoblog→thread renderer needs platform-specific awareness.

---

## 15. Open questions specifically about credentials

The user's phrasing was "encrypt them in db using our private key and use puppeteer." That's a fine intuition; the actual production design has nuance:

- **"Our private key" is dangerous if singular.** If one server compromise leaks the key, every customer's credentials are toast. Per-user DEKs make the blast radius one user, not all.
- **Asymmetric (RSA/ECDSA) vs symmetric (AES-GCM).** Asymmetric is *more* dangerous here because anyone with the public key can encrypt junk into the DB. Symmetric AES-GCM with auth-tag verification is the right primitive for at-rest credentials.
- **Vault vs HSM vs self-host.** Supabase Vault is fine for v1 (uses pgsodium under the hood). Migrate to AWS KMS / GCP KMS once we have meaningful customer count.
- **Decrypt-at-use, never at-rest.** Plaintext credentials should live only inside the Playwright worker process for the duration of a single login. Never log them, never persist them.
