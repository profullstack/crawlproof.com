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

**Phase 3 — Browser-mode fallback (cookie OR full creds): PLANNED, GATED.**
- For platforms that either (a) have no content-publish scope (Instagram personal, TikTok for non-approved apps, Snapchat) or (b) gate the API behind a long approval process we don't want to wait on.
- Two sub-modes per account:
  - `cookie` — user pastes a session-cookie blob from their already-logged-in browser. We replay those cookies in Playwright, skipping login entirely (no 2FA, no password storage). **Preferred** when available.
  - `puppeteer` — user provides username + password + optional TOTP seed. We run the full login flow in Playwright each session. Fallback when cookies aren't available or have expired.
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
-- A connected social account in the user's pool. NOT scoped to a
-- specific site — agencies reuse the same "Acme LinkedIn" connection
-- across multiple sites without re-authing. The site-to-account
-- binding lives in sp_site_account (below), which also carries
-- per-site mode flags like `auto`.
create table sp_account (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  platform text not null check (platform in (
    'x','linkedin','reddit','mastodon','bluesky','threads','pinterest','tumblr',
    'facebook_page','instagram_business','youtube','tiktok','instagram','snapchat'
  )),
  -- 'oauth'     = bearer/OAuth2 token via the platform's official API.
  -- 'cookie'    = browser automation, but we replay user-supplied
  --               session cookies; no login flow, no 2FA challenge.
  --               Preferred browser-mode auth.
  -- 'puppeteer' = browser automation with stored username + password
  --               + optional TOTP seed; we run the full login each
  --               session. Fallback when cookie auth isn't viable.
  auth_mode text not null check (auth_mode in ('oauth','cookie','puppeteer')),
  -- Display name shown in the UI ("@chovy", "Crawlproof on LinkedIn").
  handle text not null,
  -- Platform's own ID for this account (X user_id, etc.) — for dedupe + analytics.
  external_id text,
  -- OAuth tokens (encrypted at rest via Supabase Vault).
  access_token text,                              -- vault.create_secret returns the key
  refresh_token text,                             -- same
  token_expires_at timestamptz,
  -- Cookie-mode: encrypted JSON blob of Playwright-shaped cookies
  -- `[{ name, value, domain, path, httpOnly, secure, sameSite, expires }, …]`.
  -- We trust the user's paste verbatim; the worker injects these via
  -- context.addCookies() before navigating.
  enc_cookies bytea,
  cookies_acquired_at timestamptz,                -- shown in UI as "session age"
  -- Puppeteer-mode credentials (envelope-encrypted with the user's master DEK).
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
create index on sp_account(user_id);  -- RLS + listing the user's pool

-- M:N binding of connected accounts to sites the user wants to post
-- to. One account can be bound to many sites (an agency's "Acme
-- LinkedIn" can serve both acme.com and acme-product.com). Each
-- binding carries the per-site config — most importantly the `auto`
-- flag that gates AI-generated post content.
create table sp_site_account (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  site_id uuid not null references public.lx_site(id) on delete cascade,
  account_id uuid not null references sp_account(id) on delete cascade,
  -- auto=true → when this site publishes an autoblog article, we
  -- AI-generate a platform-appropriate post (text + optional image)
  -- and queue it under this account. auto=false → site lists the
  -- account as available but never fires automatically; the user
  -- composes manually.
  auto boolean not null default false,
  -- Per-site rendering knobs (override the platform defaults).
  -- Example: a financial blog might want all X posts to skip emoji.
  render_overrides jsonb not null default '{}',
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index on sp_site_account(site_id, account_id);
create index on sp_site_account(account_id);  -- "which sites use this account?"

-- A queued or sent post. One row per (platform target, scheduled-time) pair.
create table sp_post (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  site_id uuid not null references public.lx_site(id) on delete cascade,
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

## 5. Browser-mode fallback (Phase 3)

**This is the heavy section.** Doing it right is hard; doing it sloppy is dangerous (to customer accounts and to us as ToS violators). PRD captures the design *and* the case for keeping it small.

### 5.1 When we use it

A platform falls into the browser-mode path iff *both*:
- It has no OAuth content-publish scope (Instagram personal, TikTok if not approved, Snapchat).
- The customer has explicitly opted in via a disclosure modal: "We will operate your account from a server. Most platforms forbid this in their Terms of Service. If your account is banned, that's on the platform, not on us."

Within browser mode, we prefer `cookie` over `puppeteer` whenever the user can supply cookies — see §5.2.

### 5.2 Auth sub-modes

Browser mode has two sub-modes per account. The user picks at connection time; we tag the row's `auth_mode` accordingly.

#### `cookie` — session-cookie replay (preferred)

The user is already logged into the platform in their browser, with 2FA and device challenges already cleared. They export their session cookies to us; we replay those cookies in a fresh Playwright context (`context.addCookies()`) and the platform sees an authenticated session immediately. No login flow, no 2FA prompt, no password storage on our side.

**Trade-offs vs. full puppeteer login:**

| | cookie | puppeteer |
|---|---|---|
| Bypasses 2FA | ✓ | only if user gave us a TOTP seed |
| Bypasses CAPTCHA / device challenge | ✓ | ✗ |
| Stores user's password | ✗ | ✓ |
| Survives platform-side suspicious-activity logout | ✗ | ✓ (we re-login) |
| User effort to set up | one paste + occasional refresh | one paste once |
| Session lifetime before re-acquire | ~30 days typical | persistent (we re-login on expiry) |

**The cookie-extraction UX problem.** The user's original suggestion — paste the output of `document.cookie` from the browser console — works for *some* platforms but misses the critical auth cookie on most. Modern platforms (X, LinkedIn, Instagram, TikTok) set the session token with the `HttpOnly` flag, and `HttpOnly` cookies are *invisible* to JavaScript (`document.cookie` excludes them by spec). The DevTools Application panel shows them; JS does not. So the naive paste UX is a footgun.

We support three extraction paths in order of preference:

1. **Crawlproof browser extension (recommended, v2)** — a published Chrome/Firefox extension. User clicks the extension on the platform tab → it reads the full cookie jar via the extension `chrome.cookies` API (which sees HttpOnly cookies) → POSTs the relevant cookies to `/api/sp/account/cookie-ingest` over a signed Crawlproof-bound URL. One click, no console required. **This is the right long-term UX.**

2. **DevTools → Network → Copy as cURL (v1 fallback)** — the user opens DevTools, refreshes the platform page, clicks any authenticated XHR, "Copy → Copy as cURL", and pastes the curl command into Crawlproof. We parse the `-H 'Cookie: …'` line out of the curl text. This includes HttpOnly cookies because they're in the request *header*, where JS can't read them but DevTools shows them. Verbose, but works on every platform without extra software.

3. **`document.cookie` paste (v1 fallback for low-security platforms)** — for platforms whose session token is *not* HttpOnly (rare; usually a security oversight on their part). The user's original suggestion. Works fine for those; we detect "did this paste produce a working session?" on the first health check and surface a clear error if not.

The UI in `/social/setup` walks the user through whichever option they pick, with a per-platform hint about which is known to work (e.g., "Instagram — extension or curl; the console paste won't work because Meta sets `sessionid` as HttpOnly").

#### `puppeteer` — full username + password + optional TOTP

When the user can't or won't supply cookies (e.g. they want set-and-forget without periodic re-paste, or they're connecting a fresh account they'll only ever use from Crawlproof), they hand us username + password + optional TOTP seed. We store them encrypted (§5.3) and run the full login flow in Playwright every session.

CAPTCHA + device-challenge handling, residential proxy, fingerprint stability — all live in the puppeteer path (§5.4). Cookie mode skips all of that because the platform already trusts the session.

### 5.3 Credential vault

**Encryption model: envelope encryption with two keys.** "Encrypt with our private key" (the user's phrasing in the original task) is too vague to ship — what we actually need:

1. **Per-user DEK** (data encryption key): a 256-bit AES key, one per Crawlproof user, stored encrypted under a KEK.
2. **KEK** (key-encrypting key): managed by Supabase Vault (or KMS if we outgrow Vault). The KEK never leaves the secure boundary.
3. To encrypt the user's IG password (or cookie blob): pull DEK, encrypt the plaintext with AES-GCM, store ciphertext + nonce in `sp_account.enc_password` / `sp_account.enc_cookies`. The DEK is re-encrypted under KEK so the at-rest DB column never contains plaintext.
4. To decrypt for use: the worker calls Vault to unwrap the DEK, decrypts the secret just-in-time, uses it in the headless browser session, then discards from memory.

This applies identically to `enc_password`, `enc_cookies`, `enc_2fa_seed`, and `enc_username`. All four columns share one envelope per user.

This is industry-standard and what every credential-stashing product (1Password, Vault, Doppler) does. The naive "encrypt with our private key" model (one keypair for all users) is what gets companies in TechCrunch articles when one server compromise pops every credential.

### 5.4 Browser-runner cluster

Each user-platform combo gets its own isolated Playwright context. Cookie mode reuses the cluster, just without the login flow.

- **Per-user residential proxies** (Bright Data / Soax / etc.). Logging in *or operating* from a datacenter IP is the #1 detection signal. Approx $0.50/GB residential. A typical IG post needs ~50 MB of traffic, so $0.025 per post. Adds to COGS. Cookie mode reduces per-session bandwidth (no login flow assets), but the proxy is still required for the post itself.
- **Persistent user-data dirs** keyed by `(user_id, platform)`. Reuse cookies + local storage across runs so we don't trigger "new device" challenges on every action. In cookie mode this is doubly important — we inject the user's exported cookies on first run, then let the platform's own session-refresh dance keep them fresh inside our persistent context.
- **Fingerprint stability**: each (user_id, platform) gets a stable user-agent, screen size, timezone, language. The user's exported cookies were issued to *their* browser's fingerprint; if our injected fingerprint diverges too far the platform may force re-auth even with valid cookies. Mitigation: ask the user for their user-agent string at cookie-ingest time (the extension can pass it; the curl-paste UX includes it in the `-H 'User-Agent'` line).
- **2FA handling (puppeteer mode only)**: if the user provides a TOTP seed, we generate the code at login time. If they don't, we prompt them via a modal that asks them to enter the code from their authenticator (and queue the post for 2 minutes later). **Cookie mode never sees 2FA** — that's the whole point.
- **CAPTCHA (puppeteer mode only)**: 2Captcha / Anti-Captcha integration. ~$0.001/solve. Build assumes 5% of logins hit a CAPTCHA. Cookie mode rarely encounters CAPTCHA since we're not on the login page.

### 5.5 What can go wrong (and why we keep it small)

- **Cookies expire / get invalidated.** Platforms revoke sessions on signs of suspicious activity (new IP, fingerprint shift, password change). When they do, our injected cookies stop working. We detect this on the next health check (or on the next post attempt — whichever comes first) and mark the account `token_expired`, email the user, and queued posts pause. User re-pastes cookies → back in business. Typical lifetime is ~30 days; we surface "session age" in the UI so the user knows when to refresh.
- **Account bans.** Platforms detect server-side activity from residential IPs eventually. Cookie mode helps (no login flow to trip detection on every session) but doesn't eliminate the risk. Expected attrition: ~3%/month for cookie-mode accounts, ~5%/month for puppeteer-mode. Disclosure modal MUST make this clear.
- **2FA push notifications (puppeteer mode only).** Some platforms now require a phone-tap to approve new logins. If the user doesn't have TOTP, we get stuck. Cookie mode dodges this entirely.
- **Platform UI changes.** Every IG redesign breaks our selectors. Need a regression test that runs once per day and pages the on-call when it fails. Affects both modes (the post-composition selectors are the same).
- **Platform ToS friction**: most platforms' ToS technically forbid automation, but every customer has explicitly authorized us to act on their account (that's what the connect flow *is*). The disclosure modal at connect time covers the customer-expectations side. The real operational risk is the platform banning the *user's* account — that's the customer's problem to weigh, and the modal makes sure they go in eyes-open.

### 5.6 The cookie-ingest flow (UI walkthrough)

For a v1 ship, the user-facing flow at `/social/setup` for a cookie-mode platform:

1. User clicks "Connect Instagram (browser mode)" → a modal opens.
2. Modal says: "Crawlproof can post to Instagram by replaying your existing session. Pick how you want to send us the session." Three buttons:
   - **Install Crawlproof extension** (v2; greyed-out + "coming soon" pill in v1)
   - **Paste from `Copy as cURL`** (default)
   - **Paste `document.cookie`** (disabled for platforms where we know HttpOnly is required, with a tooltip explaining why)
3. For the cURL path: a screenshot-illustrated walkthrough — "Open instagram.com, log in, open DevTools (Cmd+Opt+I), Network tab, refresh, click any request, right-click → Copy → Copy as cURL, paste below."
4. Customer pastes. We parse the `-H 'Cookie: …'` and `-H 'User-Agent: …'` headers, normalize to Playwright cookie shape, encrypt, store.
5. We immediately fire a session-validity probe (load the user's profile page in a worker) to confirm the session works. Surface result inline.
6. On success: account row gets `auth_mode='cookie'`, `cookies_acquired_at=now()`, `status='active'`. User is ready to schedule posts.

When `cookies_acquired_at` ages past 25 days, the UI shows a "Refresh session" prompt. Past 35 days or on health-check failure, the account flips to `status='token_expired'` and queued posts pause.

---

## 6. AI generation pipeline (auto mode)

Each site has a set of `sp_site_account` bindings — the accounts it's allowed to post to. Each binding has an `auto` flag:

- **auto=true**: when this site publishes an autoblog article, we automatically generate a platform-appropriate post (text + optional image, video later) for this account, queue it as `sp_post`, schedule for immediate or near-future delivery.
- **auto=false**: the account is listed in the site's "available accounts" picker for manual compose, but no automatic queueing happens.

Sites can mix modes: e.g. auto-post to Bluesky + LinkedIn, manual-only for X (where the user wants editorial control on copy).

When the source is `autoblog` and at least one auto-mode binding exists, an article publishing produces one `sp_post` row per auto binding, per-platform-rendered:

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
| `sp.account.health` | hourly | For each `auth_mode in ('cookie','puppeteer')` account, run a no-op "is the session still valid" check (load the profile page). On fail: mark `token_expired`, email the user. Cookie-mode accounts also get a daily "session age >25 days" reminder. |

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
- `POST /api/sp/account/cookie` — body: `{ platform, source: 'curl'|'document_cookie'|'extension', payload, user_agent? }`. We parse the payload into Playwright cookies (`curl` path strips the `-H 'Cookie:'` line, `document_cookie` path splits on `; `, `extension` path takes the JSON our extension POSTs directly), encrypt + store. Immediately fires a session-validity probe.
- `POST /api/sp/account/cookie/refresh` — same shape; replaces the existing blob. Used by the "Refresh session" prompt.
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
9. **Browser mode — cookie variant first.** Behind a `browser_mode_enabled` flag on the user's profile. Order within this step:
   1. cURL-paste cookie ingest (§5.6) for Instagram + TikTok. No login flow to build; biggest leverage per LOC.
   2. Health-check job (cookie liveness) + "Refresh session" UI.
   3. Crawlproof browser extension (v2) for one-click ingest.
10. **Browser mode — puppeteer variant.** Full username/password/TOTP path for users who refuse cookie mode. Most operational complexity (login flow, CAPTCHA, residential proxy hygiene) lives here.

---

## 14. Open questions for before build

- **Browser extension publishing.** We need a Chrome Web Store / Firefox Add-ons listing for the v2 one-click cookie ingest. Approval timelines for "this extension exfiltrates cookies" extensions are uncertain. Plan B is a Tampermonkey userscript distributed via the docs page.
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
