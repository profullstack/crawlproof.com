# Affiliate program (OpenAffiliate)

CrawlProof runs an [OpenAffiliate](https://logicsrc.com/docs/openaffiliate) program and is the spec's reference implementation: it serves its own descriptor, joins other merchants' programs from the same dashboard, and pays in USDC on Polygon through CoinPay.

## The program we run

Terms live in one place, `lib/affiliate/program.ts`, and every surface reads them: the descriptor at `/.well-known/openaffiliate.json`, the join answer, `/affiliate`, `/affiliate/terms`, the dashboard, the CLI and the MCP tools. Today: 30% of a credits purchase within 30 days of a click, 30-day hold, USDC on Polygon weekly from $10, open approval, self-purchases refused.

How a click becomes money:

1. `proxy.ts` sees a navigation carrying `?oa=<code>` and redirects it to `/api/affiliate/v1/click`, which records the click, sets the `oa` cookie (`<code>.<unix seconds>`, 30 days) and redirects back to the same path without the parameter. Only a navigation counts (`Sec-Fetch-Dest: document`); an image, frame or script carrying the parameter sets nothing.
2. When the visitor signs in (`app/auth/callback`) or starts a purchase (`/api/credits/create-invoice`), `attributeUser` binds the user to the affiliate in `affiliate_attributions` (last touch inside the window; never the affiliate's own account).
3. When the purchase completes (`completePurchase` and the CoinPay webhook), `recordPurchaseConversion` inserts an `affiliate_conversions` row, `pending`, with `held_until` 30 days out. Idempotent on the purchase id.
4. Hourly, `/api/cron/affiliate` approves conversions past their hold (or reverses refunded ones with a reason), delivers queued webhooks, pays every membership whose approved balance is over the minimum and whose last payout is a week old, re-reads stale merchants, and re-reads stale ledgers.
5. A payout is `affiliate_request_payout` (conversions flip to `paid` under a lock) followed by `createCryptoPayout`; a failed send calls `affiliate_fail_payout` and the conversions go back to `approved`.

### Routes

| Route | Auth | What |
|---|---|---|
| `GET /.well-known/openaffiliate.json` | none | the descriptor |
| `GET /.well-known/openaffiliate-jwks.json` | none | the webhook signing key (empty set when `OPENAFFILIATE_SIGNING_KEY` is unset) |
| `POST /api/affiliate/v1/join` | none, or session, or `crp_` | join: `{ profile, pay?, webhook?, code? }` → membership, code, link, token (once), ledger URL, pays |
| `GET /api/affiliate/v1/ledger?since=` | `oa_`, `crp_` or session | the caller's ledger, spec shape |
| `GET/POST /api/affiliate/v1/me` | `crp_` or session | membership + terms + ledger; POST `{ pay?, webhook? }` |
| `POST /api/affiliate/v1/token` | `crp_` or session | rotate the `oa_` token |
| `POST /api/affiliate/v1/payout` | any of the three | send the approved balance now |
| `GET /api/affiliate/v1/click?oa=&to=` | none | the click landing (the middleware sends navigations here) |
| `GET/POST /api/affiliate/v1/programs` | GET none; POST `crp_` or session | the directory; POST `{ url }` reads a merchant |
| `POST /api/affiliate/v1/programs/join` | `crp_` or session | join another merchant: `{ origin, program?, code? }` |
| `GET /api/affiliate/v1/joined` | `crp_` or session | joined programs with last ledgers |
| `POST /api/affiliate/v1/joined/:id/sync` | `crp_` or session | read that ledger now |
| `POST /api/affiliate/v1/events/:join` | the join id | inbound webhook from a merchant we joined |
| `POST /api/cron/affiliate` | `CRON_SECRET` | the hourly sweep |
| `GET /affiliate/u/:code/openprofile.md` | none | an OpenProfile.md for one of our affiliates |
| `GET /affiliate/creatives.json` | none | artwork an affiliate may use as given |

Three credentials reach the routes: `Authorization: Bearer oa_…` (an affiliate's ledger token, what the spec promises), `Bearer crp_…` (a CrawlProof API token, mapped to that user's membership) and the session cookie. Our own users get a membership on first use; outside parties join with a profile.

### Joining other programs

The dashboard, `crawlproof affiliate join <merchant>` and the `affiliate_join` MCP tool join a merchant on the user's behalf with the user's own profile (`/affiliate/u/<code>/openprofile.md`), pay address and a webhook back to `/api/affiliate/v1/events/<join id>`. The token the merchant hands back is held in `affiliate_joins.token`, readable only through the owner.

### CLI

```
crawlproof affiliate [link] [--json]
crawlproof affiliate ledger [--since=ISO] [--json]
crawlproof affiliate pay --address 0x…
crawlproof affiliate payout
crawlproof affiliate programs [add <merchant-url>]
crawlproof affiliate join <merchant-url> [--program=id] [--code=yours]
crawlproof affiliate joined [--sync]
```

### Env

- `OPENAFFILIATE_SIGNING_KEY`: 32 random bytes, base64url, the Ed25519 seed for webhook signatures. Optional. `openssl rand -base64 32 | tr '+/' '-_' | tr -d '='`.
- `SP_TOKEN_PEPPER`: already required; peppers `oa_` tokens the same way as `crp_` ones.
- `CRON_SECRET`, `COINPAY_API_KEY`: already required; the sweep and payouts use them.

### Migration

`supabase/migrations/20260913120000_openaffiliate.sql`, applied one file at a time via the Supabase MCP. Tables `affiliate_memberships`, `affiliate_clicks`, `affiliate_attributions`, `affiliate_conversions`, `affiliate_payouts`, `affiliate_events`, `affiliate_programs`, `affiliate_joins`; RPCs `affiliate_request_payout`, `affiliate_fail_payout`; cron `crawlproof-affiliate` at 23 past every hour.

The 2026-06 `referral_codes` / `referral_usages` tables and the `@profullstack/stack/referrals` cookie stay as they were; nothing in the repo ever wrote a commission there.
