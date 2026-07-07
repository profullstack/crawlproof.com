# Crawlproof Ad Network — PRD

> Goal: turn crawlproof.com's installed base of customer domains into a two-sided **crypto-settled ad network**. Any customer can flip a switch to become a **publisher** (show ads on their site, earn crypto) and/or an **advertiser** (create ads that run across the network). Advertisers give us a landing-page URL and a daily budget; we auto-generate creative that matches the *destination* site's design and place it on publisher sites whose look/niche fit. Publishers get paid in crypto to an address they control — settled through **CoinPay**, and one-click connectable if they run **tronbrowser.dev** with the CoinPay wallet extension.
>
> This is a native extension of three things crawlproof already has: the drop-in tracker snippet (`/stats.js` → `/api/track`), the CoinPay credits/invoice rail (`lib/coinpay.ts`, `lib/credits.ts`, `/api/coinpay/webhook`), and the audit engine's ability to fetch/render a site and extract its brand (`lib/audit`, `lib/discoverLogo.ts`, `lib/datatype-font.ts`).

---

## Status as of 2026-07-07

**Not started — this document is the plan.** Nothing in `lib/`, `app/`, or `supabase/migrations/` implements ad serving yet. Phasing and open questions below. First code lands behind an `ad_network` project entitlement so it can ship dark.

---

## 1. Why this fits crawlproof

- **Supply already exists.** Customers install `/stats.js` on their sites for analytics. An ad slot is the same delivery problem: a script tag that renders a unit and phones home an event. We reuse the tracker's CORS ingest, `visitorId`/`sessionId`, geo (`lib/tracker/geo.ts`), and device (`lib/tracker/device.ts`) plumbing for impressions/clicks.
- **The money rail already exists.** CoinPay handles crypto checkout, webhooks (`/api/coinpay/webhook`), supported-coin discovery (`lib/coinpay-tokens.ts`), and credits (`lib/credits.ts`). Advertiser spend rides the existing credits system; publisher payout rides CoinPay in the *outbound* direction (new — see §7).
- **Design-matching is a known capability.** The audit engine already fetches and renders arbitrary URLs, discovers logos (`lib/discoverLogo.ts`), detects fonts (`lib/datatype-font.ts`), and reasons about page content with LLMs. "Given a URL, make an on-brand ad" is a focused reuse of that stack.
- **Crypto-native audience.** The customer base skews crypto/indie-SaaS (CoinPay, tronbrowser, coinpayportal in the same portfolio). A crypto-settled ad network with no fiat payout friction is differentiated and on-brand.

---

## 2. Personas & core loop

```
ADVERTISER                         CRAWLPROOF                        PUBLISHER
  gives landing URL + daily $  ─▶   generate on-brand creative
                                    match to eligible slots     ◀─   enables ad slot,
  funds budget (credits/crypto)     serve impression            ─▶   drops <script> / <div>
                                    meter click, debit budget
                                    accrue publisher earnings    ─▶   withdraw to crypto addr
                                                                      (CoinPay / tron wallet)
```

- **Advertiser** — an existing crawlproof user. Owns one or more **campaigns**. Each campaign = destination URL + generated creatives + daily budget cap + targeting. Pays from their credit balance (top up via CoinPay as today).
- **Publisher** — an existing crawlproof user who has at least one **project** (verified domain). Opts a project in as an ad slot, sets format/placement constraints, and provides a payout crypto address. Earns a revenue share per click (and optionally per impression).
- **Crawlproof** — the exchange. Runs the matcher, the auction/pricing, fraud checks, and takes a platform cut.

---

## 3. Data model (new tables)

All under RLS, owner/org-scoped like existing `projects`. New migration in `supabase/migrations/` (remember: prod history diverged — apply single migrations via psql over the pooler per the crawlproof-alerts note, do not `db push`).

```
ad_campaigns
  id, owner_id, org_id, name,
  destination_url, destination_domain,
  daily_budget_cents, total_budget_cents (nullable = run until paused),
  bid_model ('cpc' | 'cpm'), max_bid_cents,
  status ('draft'|'pending_review'|'active'|'paused'|'exhausted'|'rejected'),
  targeting jsonb,            -- niches[], geos[], device[], slot allow/deny
  created_at, updated_at

ad_creatives
  id, campaign_id,
  format ('banner_728x90'|'banner_300x250'|'banner_320x50'|'native'|'text'),
  headline, body, cta_text,
  image_url (nullable), logo_url (nullable),
  palette jsonb,             -- extracted from destination (bg/fg/accent, font stack)
  status ('generating'|'ready'|'rejected'),
  ai_provenance jsonb,       -- prompt + model, for audit/regeneration
  created_at

ad_slots                      -- a project opted in as supply
  id, project_id, owner_id, org_id,
  formats text[],            -- which creative sizes this slot accepts
  placement ('inline'|'sidebar'|'footer'|'sticky'),
  niche text,                -- inferred from the project's audits, editable
  brand_style jsonb,         -- extracted look of the PUBLISHER site (for native fit)
  min_cpc_cents,             -- publisher price floor
  allow_categories text[], deny_categories text[],
  status ('inactive'|'pending_review'|'active'|'paused'),
  payout_address text, payout_currency text,  -- e.g. 'usdc_pol'
  coinpay_customer_ref text nullable,          -- if connected via CoinPay/tron wallet
  created_at, updated_at

ad_impressions               -- append-only, high volume (consider daily rollups)
  id, slot_id, campaign_id, creative_id,
  visitor_id, session_id, ip_hash, geo_country, device,
  billable boolean, ts

ad_clicks
  id, impression_id, slot_id, campaign_id, creative_id,
  visitor_id, ip_hash, geo_country, device,
  charged_cents, publisher_earn_cents, platform_cut_cents,
  fraud_score, valid boolean, ts

ad_ledger                     -- double-entry-ish money movement
  id, kind ('advertiser_debit'|'publisher_accrual'|'publisher_payout'|'platform_fee'|'refund'),
  campaign_id nullable, slot_id nullable, owner_id,
  amount_cents, currency, coinpay_payment_id nullable, tx_hash nullable,
  ref_click_id nullable, created_at

ad_payouts                    -- outbound crypto withdrawals to publishers
  id, owner_id, slot_id, amount_cents, currency, address,
  status ('requested'|'sent'|'confirmed'|'failed'),
  coinpay_payout_id nullable, tx_hash nullable, created_at, settled_at
```

Reuse `tracker_daily_stats`-style rollups for impressions rather than reading the raw append table on dashboards.

---

## 4. Advertiser flow — "give a URL, get an ad"

**4.1 Create campaign.** New route `app/(app)/ads/new` (server action `app/actions/ads.ts`). Input: destination URL (run through `isAllowedTargetUrl` SSRF/scheme guard as project creation does), daily budget, optional targeting.

**4.2 Auto-generate creative (the wow moment).**
1. Fetch + render the destination with the existing audit fetch stack (respecting robots/SSRF guards already in `lib/audit`).
2. Extract brand: logo via `lib/discoverLogo.ts`, font stack via `lib/datatype-font.ts`, dominant palette from CSS/`og:image` (new small helper `lib/ads/brand.ts`), title/description/positioning from the page's meta + rendered text.
3. LLM pass (Anthropic default per README's `BACKEND_AI_PROVIDER`; Claude Opus/Sonnet) to write `headline`, `body`, `cta_text` in the destination's voice, and to pick the accent color and layout. Store `ai_provenance` so a "regenerate" button is cheap.
4. Compose creatives per requested format. **Recommended:** render each banner as an HTML/CSS template (theme-swappable, crisp on retina, no image-gen cost) rather than a raster from gpt-image-1 — image gen is a fallback/hero option only. This keeps creatives editable and cheap to A/B.
5. Human-in-the-loop: advertiser previews, tweaks copy/color, approves → `status='ready'`.

**4.3 Fund & launch.** Budget draws from the credit balance. Convert `daily_budget_cents` ↔ credits with the existing `CREDIT_RACK_CENTS` math so one currency governs the app. Launch flips campaign to `pending_review` → (auto/loose-gate) → `active`.

**4.4 Reporting.** Spend, impressions, clicks, CTR, CPC, top slots. Recharts, matching existing `components/charts`.

---

## 5. Publisher flow — "opt in, drop a tag, earn"

**5.1 Enable a slot.** On a project page (`app/(app)/projects/[id]`), a new "Monetize" tab: pick formats + placement, set a CPC floor, category allow/deny. We infer `niche` and `brand_style` from the project's existing audits so native ads match the site (this is the "match design to their site given a url" ask, applied to supply as well as demand).

**5.2 Install.** Two options, both served from crawlproof:
- **Script tag** (like `/stats.js`): `<script src="https://crawlproof.com/ad.js" data-slot="SLOT_ID"></script>` + a `<div data-cp-ad>` placeholder. `ad.js` requests a fill, renders the creative in an iframe/shadow-root (isolation), and fires impression/click beacons to `/api/ads/serve` and `/api/ads/click`.
- **Server-side/API** for advanced users: `GET /api/ads/serve?slot=…` returns creative JSON to render themselves.

**5.3 Get paid.** Provide a payout crypto address + currency (from CoinPay supported coins, `lib/coinpay-tokens.ts`). Earnings accrue in `ad_ledger` as `publisher_accrual`. Withdraw when balance ≥ a minimum → creates an `ad_payouts` row → CoinPay outbound transfer (§7).

**5.4 CoinPay / tronbrowser one-click connect.** If the publisher browses with **tronbrowser.dev** running the **CoinPay wallet extension**, a "Connect wallet" button uses the extension's injected provider to (a) fill the payout address automatically and (b) link a `coinpay_customer_ref` so payouts route through their CoinPay account with no copy-paste. Non-tron users just paste an address. (Coordinate with the coinpay-extension provider surface — see the coinpay-browser-extension note.)

---

## 6. Matching, pricing & auction

**6.1 Eligibility filter.** For a slot request: campaigns that are `active`, have remaining daily budget, whose `format` ∈ slot formats, whose category passes the slot's allow/deny and the campaign's targeting (niche/geo/device), and `max_bid_cents ≥ slot.min_cpc_cents`.

**6.2 Ranking (v1).** Simple second-price-ish: rank eligible by `effective_bid = max_bid_cents × quality_factor`, serve the top; charge `max(second_bid, floor) + 1¢`. `quality_factor` seeds at 1.0 and later folds in CTR and niche-fit. **v1 can start as a flat CPC** (no auction) to de-risk — auction is a fast-follow.

**6.3 Revenue share.** Per valid click: `charged_cents` debits advertiser; `publisher_earn_cents = charged × (1 − platform_rate)`; `platform_cut_cents` to us. Default `platform_rate` ~30% (config, revisit). Recorded atomically in `ad_ledger` + `ad_clicks`.

**6.4 Budget pacing.** Debit budget on each billable click; when daily spend hits `daily_budget_cents`, stop serving that campaign until the UTC day rolls (a `scheduled-ads` cron alongside existing crons in `app/api/cron`).

---

## 7. Money movement (CoinPay, both directions)

**Inbound (advertiser funding) — reuse today's rail.** Top-ups are credit-pack purchases via `createCheckout`/CoinPay invoice + `/api/coinpay/webhook` (already built). No change beyond letting credits be spent by the ad engine.

**Outbound (publisher payout) — new.** Requires a CoinPay **payout/transfer** capability (send crypto *from* the crawlproof merchant balance *to* a publisher address). Open dependency: confirm CoinPay exposes a payouts API; if not, this is a coinpayportal-side ask. Payout lifecycle:
1. Publisher requests withdrawal ≥ minimum → `ad_payouts(status='requested')`.
2. Backend calls CoinPay payout with `{address, currency, amount}` → `status='sent'`, store `coinpay_payout_id`.
3. CoinPay webhook (extend `/api/coinpay/webhook` with payout events) → `status='confirmed'` + `tx_hash`, write `publisher_payout` ledger row.

**Accounting invariant:** sum(advertiser_debit) = sum(publisher_accrual) + sum(platform_fee) + sum(refund), per campaign, always. Reconciliation job flags drift.

---

## 8. Fraud & quality (table stakes for an ad network)

- **Click validity:** dedupe by `(visitor_id, campaign_id)` within a window; drop bot UAs; rate-limit per IP hash; ignore clicks without a matching billable impression. Only `valid=true` clicks charge/accrue.
- **Impression validity:** viewability signal from `ad.js` (in-viewport + min dwell) before an impression is billable for CPM.
- **Supply quality:** a slot only goes `active` after its project domain is verified (publishers already prove domain ownership for projects) and passes the same loose category gate the link-exchange uses. Deny adult/illegal categories globally.
- **Advertiser safety:** destination URL re-checked for SSRF/malware category before `active`; creatives moderated (reuse the autoblog inappropriate-content check pattern).

---

## 9. Surfaces & files (where code lands)

```
app/(app)/ads/                     advertiser dashboard (campaigns, new, [id])
app/(app)/projects/[id]            + "Monetize" tab for publishers
app/actions/ads.ts                 create/update campaign, enable slot, request payout
app/api/ads/serve/route.ts         slot fill (public, CORS like /api/track)
app/api/ads/click/route.ts         click beacon → charge/accrue
app/api/ads/impression/route.ts    impression beacon (viewability)
app/ad.js                          the drop-in tag (sibling of app/stats.js)
app/api/cron/ads-pacing            daily budget reset + payout sweeps
lib/ads/brand.ts                   palette/logo/font extraction (wraps discoverLogo, datatype-font)
lib/ads/creative.ts                LLM creative generation + HTML banner templates
lib/ads/match.ts                   eligibility + ranking/auction
lib/ads/ledger.ts                  atomic debit/accrue/payout helpers
lib/coinpay-payouts.ts             outbound CoinPay transfer client (new)
supabase/migrations/<ts>_ad_network.sql
components/ads/*                    creative preview, campaign forms, earnings widgets
```

---

## 10. Phasing

- **Phase 0 — schema + entitlement.** Migration, `ad_network` project entitlement, RLS. Ships dark.
- **Phase 1 — advertiser creative studio.** URL → brand extraction → LLM creative → HTML banner templates → preview/approve. **This is the demoable centerpiece** and has no dependency on live supply. Fund from existing credits.
- **Phase 2 — supply + serving.** `ad.js`, slot opt-in, `/api/ads/serve|click|impression`, flat-CPC matching, impression/click metering, ledger accrual. Internal/portfolio sites (coinpayportal, sh1pt, threatcrush) as first publishers.
- **Phase 3 — publisher payouts.** CoinPay outbound + tronbrowser/extension one-click connect + withdrawal UI. (Gated on CoinPay payout API — §7.)
- **Phase 4 — auction, pacing, fraud hardening, viewability CPM, reporting depth.**

---

## 11. Open questions

1. **CoinPay payouts API** — does an outbound/transfer endpoint exist, or must coinpayportal build it? Blocks Phase 3. (Most important.)
2. **Pricing unit** — do publisher earnings live in the same `credits` ledger (redeemed to crypto at withdrawal) or a separate cents-denominated `ad_ledger` from day one? Leaning separate ledger, credits only for advertiser *spend*.
3. **Platform take rate** — 30% default; validate against comparable networks.
4. **Creative rendering** — HTML/CSS templates (recommended) vs raster image-gen. Confirm iframe/shadow-root isolation strategy for `ad.js` so publisher CSS can't bleed in and ads can't touch the host page.
5. **Regulatory/quality floor** — global category denylist, and whether we require advertiser destinations to be crawlproof-audited (nice funnel: "audit your landing page before you advertise it").
6. **Minimum withdrawal & gas** — who eats network fees on payout; set a sensible minimum so gas isn't a large fraction.

---

## 12. Non-goals (v1)

- No fiat payout. Crypto-only, by design.
- No real-time header-bidding / external DSP integration. Self-serve, on-network demand only.
- No video/rich-media ads. Banner/native/text first.
- No third-party (non-crawlproof-customer) publishers at launch — supply is the installed base, which also keeps the quality gate simple.
