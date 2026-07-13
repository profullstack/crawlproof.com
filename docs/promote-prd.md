# Crawlproof Promote — PRD

> Goal: a new **global, top-level** feature (peer of Ads and Alerts, *not* scoped to a single project) where the customer pastes a list of links, and AI writes a fresh, custom marketing pitch for **each link × each platform**, then drip-publishes them across **all connected social accounts on a recurring cadence** (default every 30 minutes). Every send is uniquely generated — never the same copy twice — using OpenAI and/or Anthropic.
>
> Topnav label: **Promote**. Route: `/promote`.

---

## 0. Why this is NOT `/social`

The social feature (the `sp_feed_*` engine) lives **per-project** at `app/(app)/projects/[id]/social/` and is **source-driven**: it watches a project's RSS feed or sitemap, and when a *new article* appears it auto-generates one post per platform sharing that article. Input = "whatever my blog published." Scope = one project.

> Note: the bare `app/(app)/social/page.tsx` is only a **legacy redirect** — it resolves the active project from the picker cookie and bounces to `/projects/[id]/social` (which is why clicking it "forwards to the last page you were on"). There is no real global social page today; account connection currently lives at the per-project `.../social/setup`. Promote, being genuinely global, should get its **own** account-connect surface (see §3.2) rather than routing users through a project.

**Promote is different on both axes:**

| | `/social` (existing) | `/promote` (this PRD) |
|---|---|---|
| Scope | Per-project (`/projects/[id]/social`) | **Global / account-level** (`/promote`, like `/ads`, `/alerts`) |
| Input | RSS/sitemap feed — reacts to newly-published URLs | **A hand-pasted list of arbitrary links** the user wants to push |
| Trigger | New feed item detected | Recurring drip timer (default 30 min), independent of any feed |
| Content | One post per new article | **A freshly-written marketing pitch per link, regenerated every cycle** |
| Reuse | — | Reuses the same `sp_account` connected-account pool + credit ledger |

They share plumbing (connected accounts, the publish layer, credits) but are separate features with separate tables and separate worker sweeps. Do not overload `sp_feed_*` for this.

---

## 1. Status as of 2026-07-13

**Phase 0 — PRD: this document.**

**Phase 1 — Core drip engine: PLANNED.**
- `/promote` page in the topnav. Paste links → create a "Promote list" → it starts dripping on a schedule.
- Reuses `sp_account` (the global connected-account pool) and the existing publish layer used by `sp_post` / `sp_publish_attempt`.
- Reuses the credit ledger: **1 credit per platform per post** (same as `/social` and audits).
- LLM copy generation via the same dual-provider clients already wired into the worker (`Anthropic` + `OpenAI`, see `lib/sp/feedAutopost.ts` `FeedAutopostClients`).

**Phase 2 — Targeting, rotation & polish: PLANNED.**
- Per-link marketing angle/notes, per-platform inclusion toggles, quiet hours, per-list cadence override, pause/resume, "post now."
- Optional per-post image generation (gpt-image-1), matching `/social`'s image path.

**Phase 3 — Analytics & de-dup intelligence: PLANNED.**
- Click tracking (reuse the Ads/`ref_slug` short-link machinery where possible), per-link/per-platform performance, and "don't repeat the same angle within N cycles" memory.

---

## 2. User story

> As a growth marketer I have 20 links I want to keep promoting (my product pages, blog posts, a Product Hunt launch, an affiliate offer). I paste all 20 into **Promote**, connect my socials once, and CrawlProof quietly posts a *different, human-sounding pitch* for a rotating link across every account every 30 minutes — forever — until I pause it. I never write a single post myself.

**Core loop:** every cadence tick, the engine picks the next due `(link, platform, account)` combination, asks the LLM for a fresh pitch tailored to that platform's voice + character limits, spends 1 credit, publishes, and records the attempt. It round-robins through links so no single link dominates, and never reuses the exact copy.

---

## 3. UX

### 3.1 Topnav
Add `<Link href="/promote">Promote</Link>` in `app/(app)/layout.tsx`, between `Alerts` and `Recent` (or after `Ads`). Global, not under a project.

### 3.2 `/promote` (list index)
- Header: "Promote" + short blurb ("Paste links. We write a fresh pitch for each and drip them across all your connected accounts.").
- Empty state → CTA "New promote list."
- Table of the user's promote lists: name, # links, target platforms, cadence, status (running/paused), last posted, posts sent, credits spent. Row actions: Pause/Resume, Edit, Post now, Delete.
- If the user has **zero connected accounts**, inline callout with a **Connect account** CTA. Because `sp_account` is already account-global (rows are keyed by `user_id`, not project), Promote should expose its own global connect route — e.g. `/promote/accounts` — that reuses the existing connect *component/logic* from `app/(app)/projects/[id]/social/setup/form.tsx` but without a project in the URL. Accounts connected anywhere (here or via a project's social setup) show up in both places, since they share the same pool.

### 3.3 `/promote/new` and `/promote/[id]`
- **Name** (optional; default "Promote list N").
- **Links** — a big textarea: paste one URL per line (also accept comma/space separated; dedupe; validate `http(s)://`). Each line becomes a `promo_link` row. Optional inline "angle" field per link in the edit view (e.g. "emphasize the free tier").
- **Accounts / platforms** — multiselect of the user's connected `sp_account`s (default: all active), with a "Connect account" link to `/promote/accounts` for first-timers. "All connected accounts" is the default and stays dynamic (newly-connected accounts auto-join unless the user pinned an explicit set).
- **Cadence** — default **every 30 minutes**; presets 15m / 30m / 1h / 3h / 6h / daily; the value is the *global drip interval for the whole list*, i.e. one post fires per tick (not one-per-account-per-tick) to avoid spamming. (Configurable: see §5 "burst vs. trickle".)
- **Quiet hours** (Phase 2) — optional local-time window to suppress.
- **Brand voice / global instructions** — freeform, fed into every prompt.
- Save → status `running`, `next_run_at = now + cadence`.

---

## 4. Data model (Supabase)

New tables prefixed `promo_`. Reuse `sp_account` for connections and the existing credit ledger (`consume_credit` RPC, `profiles.credits_balance`).

```sql
-- A promote campaign owned by a user (account-global, NOT per-project).
create table if not exists public.promo_list (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,

  name text not null default 'Promote list',
  status text not null default 'running'
    check (status in ('running','paused','archived')),

  -- Drip cadence in seconds. Default 1800 (30 min).
  cadence_seconds int not null default 1800
    check (cadence_seconds between 300 and 604800),

  -- 'trickle' = one post per tick, round-robin (default, safest).
  -- 'burst'   = one post to EVERY targeted account each tick.
  post_mode text not null default 'trickle'
    check (post_mode in ('trickle','burst')),

  -- NULL target_account_ids => "all active connected accounts" (dynamic).
  -- Non-null => an explicit pinned array of sp_account ids.
  target_account_ids uuid[],

  -- Freeform brand voice / global generation instructions.
  brand_voice text,

  -- Optional local quiet-hours window (Phase 2). 'America/New_York' etc.
  quiet_start smallint,          -- hour 0-23, null = disabled
  quiet_end   smallint,
  timezone text,

  -- Scheduler bookkeeping.
  next_run_at timestamptz not null default now(),
  last_run_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One link in a promote list. Round-robin cursor lives here.
create table if not exists public.promo_link (
  id uuid primary key default gen_random_uuid(),
  list_id uuid not null references public.promo_list(id) on delete cascade,

  url text not null,
  title text,                    -- best-effort fetched <title>/og:title for the LLM
  angle text,                    -- per-link marketing hint, optional

  -- Fairness: least-recently-promoted link is picked first.
  last_promoted_at timestamptz,
  times_promoted int not null default 0,

  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  unique (list_id, url)
);

-- Every generated + published post. Mirrors sp_post's role for the drip engine.
-- We keep this separate from sp_post so the two features stay decoupled, but
-- the actual PLATFORM publish call reuses the same lib/sp publish helpers.
create table if not exists public.promo_post (
  id uuid primary key default gen_random_uuid(),
  list_id uuid not null references public.promo_list(id) on delete cascade,
  link_id uuid not null references public.promo_link(id) on delete cascade,
  account_id uuid not null references public.sp_account(id) on delete cascade,

  platform text not null,        -- denormalized from sp_account for querying
  body text not null,            -- the LLM-generated pitch actually posted
  provider text,                 -- 'anthropic' | 'openai' (which model wrote it)
  model text,

  status text not null default 'pending'
    check (status in ('pending','posted','failed','skipped')),
  external_post_id text,         -- platform post id / permalink when known
  error text,
  credits_spent int not null default 0,

  created_at timestamptz not null default now(),
  posted_at timestamptz
);

create index on public.promo_list (status, next_run_at);
create index on public.promo_link (list_id, enabled, last_promoted_at);
create index on public.promo_post (list_id, created_at desc);
```

RLS: owner-only on all three, mirroring `sp_*` policies (`user_id = auth.uid()`, and for child tables via the parent list's `user_id`).

---

## 5. Scheduler & worker

Add a `promoteSweep()` to `worker/index.ts` alongside the existing `socialFeedSweep` / `browserPostSweep` / `uptimeSweep` sweeps, on a `setInterval` (60s poll; the per-list `cadence_seconds` gates actual firing).

```
promoteSweep() every 60s:
  select * from promo_list
    where status = 'running' and next_run_at <= now()
    for update skip locked            -- multi-worker safe
  for each due list:
    if in quiet hours: bump next_run_at past the window, continue
    accounts = resolveAccounts(list)  -- target_account_ids OR all active sp_account
    if accounts empty: skip (leave a note), bump next_run_at
    pick link(s):
      trickle: 1 least-recently-promoted enabled link
      burst:   same link, all accounts this tick
    for each (link, account) to post this tick:
      if user credits_balance < 1: mark list 'paused' w/ reason, break
      body = generatePitch({ link, platform, brandVoice, angle,
                             anthropic, openai })   // fresh every time
      consume_credit(user_id, 1)
      publish via existing lib/sp publisher for account.platform
      insert promo_post(status, external_post_id/error, credits_spent)
    update link.last_promoted_at, times_promoted
    list.last_run_at = now
    list.next_run_at = now + cadence_seconds
```

**trickle vs. burst.** Default `trickle` = one post per tick, round-robin across accounts *and* links, so a 30-min cadence with 4 accounts and 20 links spreads gently (each account posts every ~2h, each link resurfaces slowly). `burst` posts to every targeted account each tick — louder, higher credit burn, opt-in.

**Freshness guarantee.** `generatePitch` always calls the LLM live — no caching of bodies. To avoid near-duplicates, pass the last K `promo_post.body` values for that `(link, platform)` into the prompt as "avoid repeating these." Temperature high-ish; per-platform system prompt (char limits, hashtag norms, tone) reused from `/social`'s per-platform styling where it already exists.

**Provider selection.** Reuse the worker's already-instantiated `anthropic` + `openai` clients (`FeedAutopostClients` pattern). Default to Anthropic (Claude Sonnet) for copy; fall back to OpenAI if Anthropic is unset/errors; if only `openai` is configured, use it. Record which wrote each post in `promo_post.provider/model`.

**Safety / rate limits.** Respect the same per-platform throttle the feed engine uses (`POST_THROTTLE_MS`) so Promote + `/social` don't both hammer the same account. Consecutive-failure backoff via `sp_account.consecutive_failures` (already tracked). Cap posts-per-list-per-day (config, default generous) and surface it.

---

## 6. Credits & billing
- **1 credit per platform per post**, debited via `consume_credit` at publish time — identical to `/social` and audits. No new SKU.
- Insufficient credits → auto-pause the list with a clear reason + link to `/settings/billing`; resume automatically is *not* done (user must top up and un-pause), matching how the rest of the app fails closed.
- Show projected burn on the edit screen ("~48 posts/day × 4 platforms = ~192 credits/day at this cadence").

---

## 7. Content generation contract (`lib/promote/generatePitch.ts`)

```ts
generatePitch({
  url, title, angle, platform, brandVoice,
  recentBodies,            // last K posts for this (link, platform) to avoid repeats
  anthropic, openai,       // reused clients
}): Promise<{ body: string; provider: string; model: string }>
```
- Best-effort fetch of the link's `<title>`/OG metadata once at link-creation time (store on `promo_link.title`) to ground the pitch; re-fetch lazily if missing.
- Per-platform constraints baked into the system prompt (X ≤ 280, LinkedIn long-form ok, Bluesky ≤ 300, Reddit needs a real title, Mastodon 500, Threads 500, Discord/Telegram freeform).
- Output is plain post text (+ the URL). No markdown fences.

---

## 8. Build checklist (Phase 1)

- [ ] Migration `supabase/migrations/<ts>_promote.sql` — `promo_list`, `promo_link`, `promo_post` + RLS.
- [ ] `app/(app)/promote/page.tsx` — list index (SSR, owner-scoped).
- [ ] `app/(app)/promote/new/*` + `app/(app)/promote/[id]/*` — create/edit, paste-links textarea, account multiselect, cadence, pause/resume, "Post now."
- [ ] Topnav link in `app/(app)/layout.tsx`.
- [ ] `app/(app)/promote/accounts/*` — global connect surface reusing `projects/[id]/social/setup/form.tsx` logic without a project in the URL (writes the same account-global `sp_account` pool).
- [ ] `lib/promote/generatePitch.ts` — dual-provider copywriter with anti-repeat.
- [ ] `lib/promote/sweep.ts` — `processDuePromoteLists()` (pure, testable), wired into `worker/index.ts` via `setInterval` + the HTTP-enqueue fast path if desired.
- [ ] Reuse `lib/sp` publisher(s) for the actual platform post; reuse `consume_credit`.
- [ ] Vitest: link parsing/dedupe, round-robin fairness, trickle vs burst selection, quiet-hours skip, credit-exhaustion auto-pause, anti-repeat prompt assembly.

## 9. Open questions
- **"Post now"** — fire the whole next tick immediately, or just one post? (Lean: one post, same as a normal tick.)
- **Cross-feature de-dup** — if `/social` already posted a given URL today, should Promote suppress it? (Phase 3; probably a soft warning, not a hard block, since they're intentionally different surfaces.)
- **Link expiry** — auto-disable a `promo_link` after N consecutive publish failures or a 404 on the URL? (Phase 2.)
- **Short links / click tracking** — reuse the Ads `ref_slug` redirector so Promote clicks are measurable? (Phase 3.)
