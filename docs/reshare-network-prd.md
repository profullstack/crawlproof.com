# Crawlproof Reshare Network — PRD

> Goal: a consent-based, quality-gated **reshare network** inside crawlproof.com, spanning **all connected social platforms**. A customer opts one or more of their already-connected accounts into the network; when another member publishes an on-topic post, we **reshare it from the customer's account** — and, reciprocally, network members reshare the customer's posts. Same credit ledger as audits / autoblog / social posting.
>
> This is the `lib/lx/` **link-exchange reciprocity model applied to social reshares instead of backlinks**, riding on the `lib/sp/` connected-account infrastructure that already exists (14 platforms, OAuth + browser modes). The wedge: we already own both ends — the content generator *and* the distribution accounts — and we already have a niche/quality **gate** (`@profullstack/autoblog/quality` `gatePost`) to keep the network from becoming a spam swamp.
>
> **All social platforms are in scope.** The catch: "reshare" is not one mechanism. Some platforms expose a **free, first-class API repost action**; some gate it behind a **paid or spam-sensitive API**; some have **no repost API at all** (browser automation only). We roll out **by repost mechanism**, cleanest first — nothing is dropped, but the risky surfaces ship behind the same gated, opt-in disclosure model as Social Posting Phase 3. See §7 for the full matrix.

---

## 1. Repost mechanism per platform — the organizing fact

Every platform in `sp_account` (`bluesky, mastodon, reddit, linkedin, threads, pinterest, tumblr, x, facebook_page, instagram_business, youtube, tiktok, instagram, snapchat`) is covered. What differs is *how* a reshare happens and how much risk it carries:

| Platform | Reshare mechanism | API? | Cost | Risk tier |
|---|---|---|---|---|
| **Bluesky** | `app.bsky.feed.repost` record | ✅ official | free | **1** |
| **Mastodon** | `POST /statuses/:id/reblog` | ✅ official | free | **1** |
| **Tumblr** | `POST /blog/:id/post/reblog` (native reblog) | ✅ official | free | **1** |
| **Telegram** | `forwardMessage` / `copyMessage` (Bot API) | ✅ official | free | **1** |
| **X** | `POST /2/users/:id/retweets` | ✅ official | **paid tier** | **2** |
| **Threads** | repost endpoint (Graph, newer/stricter) | ✅ official | free | **2** |
| **Reddit** | crosspost (`/api/submit` kind=crosspost) | ✅ official | free | **2** (per-subreddit rules) |
| **Pinterest** | save/repin to a board | ✅ official | free | **2** |
| **Discord** | crosspost announcement message | ✅ official | free | **2** (announcement channels only) |
| **LinkedIn** | in-UI reshare — no clean API reshare | ❌ browser | — | **3** |
| **Facebook Page** | share (Graph share deprecated) | ❌ browser | — | **3** |
| **Instagram / IG Business** | no native repost — browser | ❌ browser | — | **3** |
| **TikTok** | in-app repost only, no API — browser | ❌ browser | — | **3** |
| **YouTube** | no repost concept (community reshare not API-exposed) | ❌ n/a | — | **excluded** |

Tiering tracks risk almost exactly: the API-native reshare actions are normal platform behavior; the browser-automated ones put the **customer's own account** at suspension risk (§7). We ship Tier 1 → 2 → 3.

---

## 2. Status / phasing

**Phase 0 — PRD: this document.**

**Phase 1 — Tier 1 (free, first-class API reshare): PLANNED, ships first.**
- Bluesky, Mastodon, Tumblr, Telegram. Add a `repost()` action to each adapter (today `lib/sp/platforms/*` publish *original* posts only). Lowest risk, no paid tiers, no browser. This is where we prove the mechanic.

**Phase 2 — Tier 2 (official API, paid or spam-sensitive): GATED.**
- X (paid API tier + disclosure), Threads, Reddit (crosspost → requires a target subreddit + honors subreddit rules), Pinterest (repin to board), Discord (announcement-channel crosspost). Each ships behind a per-platform risk disclosure; opens only after Phase 1 shows a near-zero suspension rate (§10).

**Phase 3 — Tier 3 (browser-mode reshare): GATED, OPT-IN, mirrors Social Posting Phase 3.**
- LinkedIn, Facebook Page, Instagram, TikTok. Reuses the existing browser runner (`lib/sp/platforms/browser.ts`, `browserSemaphore.ts`) with `cookie`/`puppeteer` `auth_mode`, isolated runner cluster, residential proxies, encrypted-credential vault, and a hard disclosure modal. Highest account-ban risk — opt-in per account, capped hardest, and the first surface we pause if suspensions appear.

**YouTube — excluded** from reshare (no API repost primitive; a "community post" is original content, not a reshare). Stays a Social-Posting-only platform.

---

## 3. Why this fits crawlproof's existing rails

### 3.1 `lib/sp/` — connected accounts + publishing (SHIPPED)
- `sp_account` — user-scoped pool, all 14 platforms already enumerated, with `auth_mode in ('oauth','cookie','puppeteer')`, `enc_access_token`, `status`, `last_post_at`, `consecutive_failures`.
- `sp_site_account` — M:N site↔account binding + `auto` flag.
- `sp_post` / `sp_publish_attempt` — queued/sent log + attempt trail.
- Adapters `lib/sp/platforms/{bluesky,mastodon,reddit,linkedin,threads,facebook,telegram,discord,x}.ts` + `browser.ts`; OAuth refresh (`sessionRefresh.ts`); vault (`vault.ts`, `SOCIAL_VAULT_KEY`); browser concurrency (`browserSemaphore.ts`).
- **What's missing:** every adapter does *original* posts only (`createTweet`, Bluesky `createRecord`, Mastodon `POST /statuses`, LinkedIn `ShareContent`, browser flows). No reshare action exists yet — that's the core new adapter work (§5).

### 3.2 `lib/lx/` — the reciprocity network we're cloning
- outrank.so-style multi-tenant exchange: any opted-in customer both gives and receives.
- Per-participant **niche allowlist + heuristic + LLM quality score** via `gatePost` (loose case-insensitive niche overlap, fail-open on LLM error).
- Per-site opt-in toggle; credit ledger; a matcher pairing givers to receivers.

The reshare network is `lx` with the edge type changed from *backlink* to *reshare*, and the target from *a blog article* to *a social post*.

---

## 4. Positioning & the "army" framing

- Sold as an **add-on**, like Autoblog and Social Posting.
- Consumer name: "Reshare Network" / amplification network. Internally it is **consent-based reciprocal distribution, not an anonymous bot ring**. Every reshare comes from a **real member's real account that opted in**, resharing **on-topic** content. That distinction is the entire defensibility story (§7).
- Tightly tied to Autoblog + Social Posting: when a customer's autoblog article auto-posts to their connected accounts (existing `auto` pipeline), that post becomes eligible for network amplification. We own the content *and* the amplification.

---

## 5. Data model (Supabase)

New tables, all `rn_`-prefixed. Mirrors `lx_*`, rides on existing `sp_account`. `platform` columns use the **same full enum as `sp_account`** so every platform is representable from day one, even before its adapter ships.

```sql
create table rn_membership (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references public.profiles(id) on delete cascade,
  sp_account_id     uuid not null references public.sp_account(id) on delete cascade,

  niches            text[] not null default '{}',      -- ['seo','devtools']
  languages         text[] not null default '{en}',

  give_enabled      boolean not null default true,      -- will reshare others
  receive_enabled   boolean not null default true,      -- wants to be reshared
  max_reshares_per_day int not null default 5
                      check (max_reshares_per_day between 0 and 20),
  min_gate_score    numeric not null default 0.6,

  status            text not null default 'active'
                      check (status in ('active','paused','suspended','user_disabled')),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (sp_account_id)
);

create table rn_source_post (
  id                uuid primary key default gen_random_uuid(),
  membership_id     uuid not null references rn_membership(id) on delete cascade,
  -- full sp_account platform enum — every platform representable
  platform          text not null check (platform in (
                      'bluesky','mastodon','reddit','linkedin','threads','pinterest','tumblr',
                      'x','facebook_page','instagram_business','tiktok','instagram')),
  external_post_id  text not null,                      -- at:// uri, status id, tweet id, pin id…
  post_url          text,
  text_snippet      text,
  niches            text[] not null default '{}',
  gate_score        numeric,
  gate_ok           boolean,
  target_reshares   int not null default 0,
  reshares_done     int not null default 0,
  status            text not null default 'pending'
                      check (status in ('pending','gating','active','done','rejected')),
  -- Reddit crosspost needs a destination; Discord needs a followed
  -- announcement channel. Per-actor routing lives in rn_reshare.target_ref.
  created_at        timestamptz not null default now(),
  unique (platform, external_post_id)
);

create table rn_reshare (
  id                uuid primary key default gen_random_uuid(),
  source_post_id    uuid not null references rn_source_post(id) on delete cascade,
  actor_membership_id uuid not null references rn_membership(id) on delete cascade,
  platform          text not null,
  mechanism         text not null check (mechanism in (
                      'repost','reblog','forward','retweet','crosspost','repin','browser')),
  target_ref        text,                               -- subreddit / board / channel, when required
  external_reshare_id text,                             -- the repost/reblog record id
  status            text not null default 'queued'
                      check (status in ('queued','sent','failed','skipped','undone')),
  gate_score        numeric,
  scheduled_for     timestamptz,                        -- jittered (§6)
  sent_at           timestamptz,
  error             text,
  created_at        timestamptz not null default now(),
  unique (source_post_id, actor_membership_id)
);
```

RLS: `rn_membership` owner-scoped via `sp_account.user_id`. `rn_source_post` / `rn_reshare` are service-role-written by the worker; members read only rows tied to their memberships.

---

## 6. The matcher + execution

**Matcher** (worker, on new `rn_source_post`):
1. **Gate the source** with `gatePost` (`@profullstack/autoblog/quality`) — reject spam/off-niche/low-quality; cache `gate_score`/`gate_ok`. Default `min_gate_score = 0.6` (stricter than backlinks — a bad reshare pollutes the actor's *public timeline*, not just a footer).
2. **Candidate actors:** `rn_membership` where `give_enabled`, **same platform**, `status='active'`, **niche + language overlap**, not the author, under `max_reshares_per_day`.
3. **Reciprocity weighting:** prefer actors the author reshares back — give/receive balance per pair, so the network stays mutual (mirrors `lx`'s ledger).
4. **Fan-out cap:** `target_reshares = min(cap, eligible actors, per-source ceiling)`. Never amplify one post to the whole network at once — that burst is *the* detectable manipulation signal (§7).
5. Insert `rn_reshare` rows with the platform's `mechanism`, `target_ref` where required (Reddit subreddit / Discord channel / Pinterest board), and **jittered `scheduled_for`**.

**Execution** (worker drains due `rn_reshare`): dispatch to the new adapter reshare action per §1's mechanism column. Spread over time (jitter + `max_reshares_per_day` + actor active-window skew from `sp_account.last_post_at`), never bursts. On success: write `external_reshare_id`, `sent_at`, bump `reshares_done`, debit 1 credit. On `suspended_by_platform`/auth failure: set `sp_account.status`, pause the `rn_membership`, stop scheduling it, email the owner. **Account safety > completing a fan-out.**

New adapter work (the only genuinely new code), one reshare action each:
- Tier 1: `bluesky.repost` (createRecord `app.bsky.feed.repost`), `mastodon.reblog` (`/statuses/:id/reblog`), `tumblr.reblog` (`/post/reblog`), `telegram.forward` (`forwardMessage`/`copyMessage`).
- Tier 2: `x.retweet` (`/2/users/:id/retweets`, paid), `threads.repost`, `reddit.crosspost` (`kind=crosspost` → `target_ref` subreddit), `pinterest.repin` (save → board), `discord.crosspost` (announcement message).
- Tier 3: browser reshare flows in `browser.ts` for LinkedIn / Facebook / Instagram / TikTok (`cookie`/`puppeteer` mode, gated).

---

## 7. Platform risk — the load-bearing section

A reciprocal auto-reshare network is mechanically an **engagement pod / retweet ring / "reciprocal amplification"** pattern. **Every major platform's spam & manipulation policy prohibits it, and integrity systems detect it.** The party hurt is **the customer** (their real account rate-limited, shadow-banned, or suspended) — a growth product that suspends its own users churns catastrophically. Crawlproof already pulled the **Audience** feature for "info risk"; the same judgment gates this.

**The tiering in §1 is the risk-management spine, not a convenience ordering:**
- **Tier 1 (Bluesky, Mastodon, Tumblr, Telegram)** — reshare/reblog/forward is *normal, free, first-class API behavior* on open/federated networks with little-to-no centralized ring-detection. Lowest risk; ship and learn here.
- **Tier 2 (X, Threads, Reddit, Pinterest, Discord)** — official API exists, but each adds risk: X runs the most aggressive reciprocal-RT detection *and* charges for API; Reddit crossposts hit per-subreddit spam filters + rules; Threads review is strict. Gated behind per-platform disclosure; opens only after Tier 1 proves safe.
- **Tier 3 (LinkedIn, Facebook, Instagram, TikTok)** — **no API reshare → browser automation**, which most ToS forbid and which most endangers the customer's account. Opt-in with a hard disclosure modal, isolated runner + residential proxies, capped hardest, first to be paused on any suspension signal.

**Mitigations baked into the design (mirroring the `lx` gate philosophy), all platforms:**
1. **Real, opted-in accounts only** — never synthetic. The single biggest thing separating this from a botnet.
2. **Relevance gating** — `gatePost` niche/quality filter; only on-topic reshares. Off-topic amplification is both spammy and the clearest inauthenticity signal.
3. **Explicit per-account opt-in + disclosure modal**, with the platform-suspension risk spelled out; instant pause.
4. **Human-like cadence** — per-account daily caps, jitter, active-window skew, per-source fan-out ceiling. No bursts.
5. **Fail-safe on pushback** — first `suspended_by_platform`/throttle → pause that membership and notify, rather than pushing through.
6. **Phased by risk** — Tier 1 first; Tier 2/3 open only on a proven-safe suspension rate; browser-mode is opt-in and capped hardest.

**Explicit non-goals:** buying/selling engagement, fake accounts, follow-back schemes, comment pods, off-topic mass amplification, evading platform rate limits, or acting on any account without the owner's consent.

---

## 8. Credits

- **1 credit per reshare sent** (per actor, per source post), via the existing `consume_credit` RPC against `credit_ledger` — same ledger as audits/autoblog/social-posting. Being reshared (`receive_enabled`) is **free**; the actors pay. Keeps spend on the person getting value and makes joining attractive.
- Free-tier throttle: low `max_reshares_per_day` for free/low-balance accounts; full cap unlocks with balance. (Optional later: earn-back — reshare N others → get M free.)

---

## 9. UI surface

- **`/reshare`** (or under `/social`) — enroll accounts already in `sp_account`, grouped by platform with each platform's mechanism + risk tier shown. Per-account: niches, languages, give/receive, daily cap, min gate score, pause.
- **Network activity** — "your posts amplified: N reshares from M accounts" + "you amplified N." Reciprocity balance meter.
- **Disclosure** — a real modal at opt-in per account (harder wording for Tier 2/3), explaining exactly what auto-resharing does and the suspension risk; consent recorded with timestamp. Tier 3 additionally reuses the Social Posting Phase 3 browser-automation disclosure.

---

## 10. Build order

1. Tier 1 reshare actions in `bluesky/mastodon/tumblr/telegram` adapters (+ unit tests per `lib/sp/platforms/*` pattern).
2. `rn_*` migration (§5) with RLS.
3. Matcher + gate reuse + jittered execution + `consume_credit` debit (§6, §8).
4. `/reshare` enroll + activity UI + disclosure (§9).
5. Ops: suspension handling, **network-health dashboard — per-platform suspension rate is the KPI that gates every later tier.**
6. Tier 2 adapters (X paid / Threads / Reddit crosspost / Pinterest / Discord) behind per-platform disclosure — **open only after §5 metrics prove Tier 1 safe.**
7. Tier 3 browser-mode reshare (LinkedIn / Facebook / Instagram / TikTok) on the existing browser runner — **opt-in, capped hardest, gated on the same safety metric.**

---

## 11. Success / kill criteria

- **Tier gate:** a tier opens only when the **per-platform account-suspension rate attributable to reshares stays near zero** across a meaningful active pool *and* members report reach lift. Climbing suspensions → do **not** advance a tier; tighten caps or kill that platform (the Audience precedent).
- **Kill criteria:** any evidence a platform's network is functioning as a detectable ring (coordinated-behavior strikes, mass throttling) → pause that platform network-wide, not per-account.
