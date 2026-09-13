# Credit pricing: 400% markup on service estimates

New purchases use a minimum price of five times the documented service-cost estimates, before affiliate and payment fees. The existing 30% affiliate commission remains in force. This is an 80% margin on the estimated service cost at the floor, not an 80% net margin after all expenses.

## Catalog

| Pack | Credits | Price | Per scan | Per credit | Discount |
| --- | ---: | ---: | ---: | ---: | ---: |
| Starter | 20 | $6 | $6 | $0.30 | 0% |
| 10 scans | 200 | $54 | $5.40 | $0.27 | 10% |
| 50 scans | 1,000 | $210 | $4.20 | $0.21 | 30% |
| 100 scans | 2,000 | $300 | $3 | $0.15 | 50% |

`lib/pricing-policy.ts` holds the service estimates and markup. `lib/credits.ts` converts each action estimate into a per-credit floor, takes the largest floor, and sets a rack price that still meets it after the largest discount. Every catalog entry is calculated and guarded against falling below that floor.

## Cost basis and limits

| Action | Existing service estimate | Credit charge | Five-times estimate per credit |
| --- | ---: | ---: | ---: |
| AI scan | 26c, from the previous scan catalog estimate | 20 | 6.5c |
| Lead run | 4.9c, from the existing per-tick search/drafting/render estimate | 3 | 8.34c, rounding the action quote up |
| Outreach | 3c, from `docs/social-posting-prd.md` browser/proxy/CAPTCHA/compute estimate | 1 | 15c |

Outreach sets the 15c credit floor. A 50% maximum volume discount requires a 30c rack price. Pricing from the scan estimate alone would underprice the other documented services.

These are estimates, not enforced spending ceilings. Custom lead drafts, SMS destinations and segments, article images, GitHub fix loops, retries and x402 paid fetches have variable costs. Existing production AI usage records capture individual calls, not complete job costs. This catalog must not be presented as a guarantee of 400% markup on every actual job or on total operating costs. Update the estimates as complete job measurements become available.

Articles, guest posts and GitHub fixes still consume 20 credits. Signup grants, existing balances and action deductions are unchanged. New purchase prices cannot retroactively improve the margin on credits already sold.

## Checkout and accounting

Card and crypto invoices both read the catalog server-side. The invoice route records the quoted price and credit count before asking CoinPay to create a payment. Caller-supplied amounts cannot lower the quote. Pending and completed purchases retain their stored amounts and credit counts; completion, affiliate conversion and receipts continue using those records.

Ad budgets retain their established 5c-per-credit accounting denomination. This is a redemption value, separate from the price paid to buy credits. The SQL click and deposit-match functions, publisher payouts, historical ledger rows and existing campaign dollar limits remain unchanged. Raising the credit purchase price must not also raise the publisher payout rate and erase the intended markup. The first-deposit bonus remains ad-only.

The homepage, pricing page, billing page, GitHub fix controls, structured offers and llms.txt derive their dollar claims from the catalog. Structured offers distinguish credits from scan equivalents.

## Verification

- Cost-floor tests cover every catalog pack against every documented service estimate after discounts.
- Invoice tests cover all four packs for both card and crypto, including caller-supplied stale prices and invalid pack IDs.
- Rendered pricing, structured offers and llms.txt agree on the new prices.
- Existing ad-solvency tests retain a historical-purchase fixture and check every new pack.
