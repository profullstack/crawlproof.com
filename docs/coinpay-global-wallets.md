# Global CoinPay wallets for publisher slots

Connect CoinPay wallets at `/dashboard/ads/slots` once. The authorization-code flow uses PKCE S256, state and an OIDC nonce, with `openid profile email wallet:read`. Ordinary CoinPay sign-in keeps its existing identity-only scopes. The OAuth client registration must allow `wallet:read`; this does not grant that scope to a user until they authorize it.

The callback fetches active account-level receive addresses and linked account-level web-wallet addresses from CoinPay and stores their public metadata in a service-only table, bound to the verified CoinPay subject and CrawlProof user. It stores no access tokens, refresh tokens, signing keys or wallet secrets. No manual address fields are shown on the slots page.

The selected global wallet is the payout default for every current and future slot owned by that user. A single selector changes it for all sites. The initial choice prefers USDC and USDT chain codes, then other returned currencies in stable order. Currency/network codes are carried unchanged apart from case. Wallet addresses retain case. Existing customers' per-slot addresses remain effective until they opt into a global profile. Once configured, a missing connection or empty wallet list blocks withdrawals instead of falling back to a stale per-slot destination.

Wallet metadata is a snapshot, not a background live mirror. The page shows when it was synced. After changing wallets in CoinPay, choose **Refresh from CoinPay** once; that refresh updates every site. Disconnecting CoinPay invalidates global payout resolution even though the previous public metadata remains stored. CoinPay authorization only reads receive addresses; it does not initiate a payment. Existing user-triggered withdrawal controls remain responsible for payouts.

## CLI and API

```sh
coinpay auth login
crawlproof slots wallets sync
crawlproof slots wallets --json
```

The CLI reuses `COINPAY_SESSION_TOKEN` or the existing `~/.coinpay.json` session and the normal CrawlProof API token (`CRAWLPROOF_TOKEN` or `~/.crawlproof.json`). An expired or insufficiently scoped CoinPay session needs a new login; no addresses are copied or entered.

`GET /api/ads/v1/wallets` returns the caller's profile. `POST` accepts `coinpay_token` over HTTPS, verifies it with CoinPay, reads account wallets, and links only the authenticated CrawlProof user to the provider-verified subject. Existing conflicting links are refused. The token is used for this request and is never persisted or returned. Client-supplied addresses and subject IDs are never accepted as proof.

Slot detail GET reports the effective destination. Per-slot address PATCH/server-action writes are refused after global setup; change the global selection instead.

## Release

Apply `20261031000000_coinpay_global_wallets.sql` before the application update. Enable `wallet:read` in the existing CrawlProof CoinPay OAuth client registration. Verify the connection return URL retains the slots filter/page, the imported wallets belong to the consented subject, and one default applies to existing and new slots. Do not trigger real withdrawals to test setup.
