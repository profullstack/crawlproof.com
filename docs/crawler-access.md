# Crawler access and ad reporting

Commercial crawlers (including SemrushBot and SiteAuditBot) join the existing training-crawler policy in `@profullstack/x402-gateway`. The configured offer remains **$1 for a 24-hour pass**, settled by the existing CoinPay integration. The `/crawl` page explains how to buy and present the module's signed `x-crawl-pass`. This grants public crawl access; application authentication still protects account resources.

All recognized crawlers, including paid crawlers, have a shared Redis limit of **12 requests per minute per source IP** and **600 requests per hour per crawler family** across replicas and public/ad surfaces. Excess requests receive `429` with `Retry-After`. Rejected requests do not extend the window. Public ad redirect requests also have a 60/minute IP ceiling for browser-classified clients, in addition to the existing five-second accepted-click cooldown. Railway's `X-Real-IP` provides the rate-limit identity; caller-supplied Cloudflare/forwarded headers cannot override it.

Crawler identities in policy are user-agent classifications, not verified source attribution. Being a recognized crawler provides no rate-limit exemption. Concealing a crawler as a browser does not bypass the shared IP ceiling on ad redirects, but this policy alone is not comprehensive bot detection.

`robots.txt` excludes `/a/` and `/api/` in every relevant group. Commercial and training crawlers are directed to `/crawl`. Before any impression lookup, unpaid commercial crawlers receive the gateway's payment offer; other unpaid crawlers receive `403` for ad redirects. Valid paid passes may resolve ad links under the rate limits, but those requests create **no ad click row, cash charge, paper charge, publisher earnings, or campaign referral attribution**. Search/retrieval crawlers retain free public-page access under the same crawler limits.

Redis stores daily aggregate request outcomes by bounded crawler family and `page`/`ad` surface. It retains these for 366 days without storing IPs or full user agents in the metrics. `/api/admin/crawl-activity?days=7` exposes up to 31 days to administrators through either their session or API token. The counter labels are `requests`, `throttled`, `payment_required`, `pass_issued`, `blocked`, and `passed`; issuing/reissuing a pass is not a revenue count. Actual revenue comes from settlement and the existing sale hook.

If Redis is unavailable, recognized crawlers receive `503` and a retry delay. Human redirects remain available; the existing click admission independently withholds charges when it cannot validate them.

The earnings API uses the service-only `ad_token_earnings(owner, days)` RPC. It reads closed-day rollups plus current-day records and returns one JSON document, avoiding both missing `auth.uid()` and PostgREST row truncation. Header totals and domain rows share the requested window. Accepted clicks are billed plus free; rejected clicks remain separate. Lifetime wallet/balance totals remain explicitly lifetime. A failed reporting or balance query returns `503` without fabricated totals, allowing the TUI to retain visibly stale data.

Apply `supabase/migrations/20260913170000_ad_token_earnings.sql` before deploying the application. It adds a function and grants execution only to `service_role`; existing browser RPCs and historical click rows are preserved.

Validation commands:

```sh
npm test
npm run typecheck
node scripts/test-ad-token-earnings.mjs
node --import tsx scripts/test-crawl-limits.mjs
```

The SQL and Redis scripts use disposable local Docker containers. They verify owner isolation, role permissions, date boundaries, billed/free/rejected semantics, atomic rate admission, fixed retry windows and limits across source IPs.
