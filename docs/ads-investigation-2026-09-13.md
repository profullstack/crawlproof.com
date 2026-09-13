# Ads investigation — 13 September 2026

The production account has **both incorrect reporting and substantial crawler traffic**. The dashboard's 83 clicks are billed clicks, not all accepted clicks. Its “invalid clicks” field incorrectly contains accepted, unbilled clicks and omits the actual rejected-click bucket. Independently, the earnings endpoint intermittently returns incomplete data, including zero publisher totals, with HTTP 200.

This was a read-only production investigation. No application, database, rate-limit, or deployment changes were made during it. The earlier CLI spinner/retry changes address request feedback and client timeouts; they do not repair these server-side reporting defects.

## Verified counts

The following counts come directly from `ad_clicks`, joined to campaigns owned by the authenticated account. The API lists 361 campaigns and 40 publisher slots. These are account-scoped campaign records, not a count of every other advertiser on the network.

Snapshot: **2026-09-13 15:56:36.391839 UTC**, in a repeatable-read, read-only database transaction. “Past week” means September 7 at 00:00 UTC through that snapshot, matching the API's seven-calendar-day convention.

| Recorded outcome | Lifetime | Past week |
| --- | ---: | ---: |
| Billed clicks (`valid = true`) | 83 | 0 |
| Accepted, unbilled clicks (`valid = false`, `tier = 'free'`) | 24,603 | 13,484 |
| Rejected clicks (`valid = false`, `tier <> 'free'`) | 225,300 | 136,883 |
| Of those rejected, classified as bots | 225,197 | 136,780 |
| All recorded click attempts | 249,986 | 150,367 |

Rejected clicks account for 90.1% of lifetime attempts and 91.0% of attempts during the past week. The 83 billed clicks occurred between July 7 and July 29 and total $15.50 in advertiser charges. None occurred during the past week.

**Rejected rows have zero advertiser charges, zero publisher earnings, and zero paper charges**, both lifetime and during the past week. This establishes that the rejected traffic was not billed in these records. It does not prove that every accepted free click was a human: acceptance reflects the checks operating at the time, and user-agent classification can be evaded.

I could not reproduce an API field containing approximately 265,000 invalid clicks. A later response contained 269,788 advertiser impressions; that is a different measure. There nevertheless are 225,300 actual rejected click records in the snapshot above.

## The reporting defects

The deployed revision examined was `487da66ae4ff94e6a8f057b745c19a970805185d`. It is newer than this local checkout; production source was inspected with `git show`, without replacing local work.

1. **Free clicks are mislabeled as invalid.** In `app/api/ads/v1/earnings/route.ts:131`, the lifetime fallback sets `invalidClicks` to the sum of campaign `free_clicks`. The deployed database view defines these as unbilled free-tier clicks. `lib/ads/serve.ts:662` deliberately writes accepted promo clicks into this bucket; the charge path also uses it for accepted, unbillable delivery. Rejected clicks instead go into the non-free, non-valid bucket at `lib/ads/serve.ts:718`. The route's explanatory comment contradicts the actual write path and database definitions.

2. **The 83-click numerator excludes accepted free clicks.** The fallback takes only the view's billed `clicks` column. The TUI consumes this as all clicks and calculates CTR and the invalid-to-valid comparison from it. Those comparisons are therefore misleading. The fallback also combines advertiser-scoped “invalid” counts with publisher-scoped delivery, which need not describe the same population.

3. **The windowed reporting calls lack the caller's database identity.** `app/api/ads/v1/earnings/route.ts:34` passes a service-role client to `loadEarnings`. Production `ad_campaign_totals` and `ad_slot_totals` obtain their owner filter from `auth.uid()` and return immediately when it is null. The route does not propagate the authenticated API user's identity into those RPCs. Checking the functions without a user identity returned no campaign or slot rows despite the underlying traffic. Direct REST calls using the production service-role credentials also returned HTTP 200 with empty arrays for both functions, confirming the behavior through the actual API transport.

4. **The fallback repairs only headline delivery totals.** It substitutes lifetime view totals while the response still carries `rangeDays: 7` and empty windowed campaign/slot rows. It does include `deliveryWindow: "lifetime"`, which the Ads panel labels, but this does not supply the missing domain rows or make lifetime delivery comparable to monthly progress targets. The per-domain traffic, spend, and earnings rows returned by this endpoint are consequently unreliable even if a request is marked complete. Lifetime balance fields come from separate campaign/ledger queries.

## Why fetching and retrying still fail

Two live requests reproduced incomplete backend responses:

| Observation | First request | Second request |
| --- | ---: | ---: |
| Completion, UTC | approximately 15:52:43 | 16:03:10 |
| Response time | 18.4 s | 15.7 s |
| HTTP status | 200 | 200 |
| `statsUnavailable` | true | true |
| `deliveryWindow` | lifetime | lifetime |
| Advertiser impressions | 225,717 | 269,788 |
| Advertiser billed clicks | 62 | 83 |
| Publisher impressions / clicks | 0 / 0 | 0 / 0 |
| Incorrectly labeled `invalidClicks` | 20,154 | 24,603 |

In the second response, all 361 campaign rows and all 40 slot rows had zero delivery and windowed money. The database independently contains substantial delivery. These zeros cannot be treated as actual absence of activity.

The fallback reads lifetime campaign stats in eight sequential chunks of up to 50 IDs, alongside a publisher stats request. `readStats` drops failed chunks, retains successful chunks, and returns a failure flag; the endpoint still responds with HTTP 200. This can yield a partially counted advertiser total and an entirely empty publisher total. A retry repeats the same expensive path.

Railway HTTP logs also show earlier requests ending with HTTP 499 at approximately 19.9 seconds and “client has closed the request before server could send response,” consistent with the previous 20-second CLI timeout. Later HTTP-200 requests took roughly 9–25 seconds. Increasing the client deadline helps that transport failure, but cannot correct an incomplete server response.

Direct, isolated view probes succeeded: eight campaign chunks took approximately 14.3 seconds in total, with the slowest taking 6.75 seconds. A separate publisher-view probe took 3.60 seconds. One concurrent campaign/publisher probe also succeeded, in 1.97 and 3.83 seconds respectively. The database authenticator has an eight-second statement timeout configured. **Intermittent query timeout under load is plausible, but the exact database error for the observed API failures was not captured or reproduced in these direct probes.** The route suppresses individual view error details, limiting diagnosis. The slow fallback and incomplete HTTP-200 responses are confirmed independently of that hypothesis.

## Where the rejected traffic comes from

| Publisher property | Rejected attempts in past week | Bot-classified subset |
| --- | ---: | ---: |
| rssamplifier.com | 136,561 | 136,462 |
| nichedb.dev | 224 | 221 |
| profullstack.com | 98 | 97 |

rssamplifier.com accounts for **99.76% of the rejected attempts** in this window. Bot-linked impressions most often carry the source tags `topic`, `feed`, and `author`, consistent with crawlers encountering ad links throughout feed/content pages.

A recent Railway HTTP-log sample contained 17 ad-link requests between approximately 15:55 and 15:58 UTC. All used the `/a/` short-link route, returned HTTP 302, and supplied a SemrushBot user-agent string. This is self-identification, not verified ownership of the requests, and a small recent sample cannot identify the source of all historical rejected traffic.

**Source verification follow-up, 16:16 UTC:** After the user challenged the user-agent attribution, I retrieved Railway's `srcIp` field and checked a fresh sample. Railway documents this field as the client's source IP in its [HTTP logs](https://docs.railway.com/observability/logs). Between 16:08:32 and 16:14:19 UTC, the sample contained 32 ad-link requests claiming SemrushBot, from 20 distinct source IPs.

**All 20 IPs passed forward-confirmed reverse DNS:** their PTR records named hosts under `bl.bot.semrush.com`, and querying each hostname's A record returned the original source IP. Examples:

| Observed source IP | Reverse DNS hostname | Forward DNS result |
| --- | --- | --- |
| 85.208.96.196 | 196.bl.bot.semrush.com | 85.208.96.196 — matches |
| 185.191.171.3 | 3.bl.bot.semrush.com | 185.191.171.3 — matches |

The IPs fall within two /24 networks. RIPE's registry independently associates [85.208.96.0/24](https://rdap.db.ripe.net/ip/85.208.96.196) with `Semrush_Net` and `mnt-cy-semrush-1`, and [185.191.171.0/24](https://rdap.db.ripe.net/ip/185.191.171.3) with `SEMrush CY LTD`. Together with the matching forward and reverse DNS, this is strong source-level verification that these 32 requests originated from Semrush infrastructure. It goes beyond the copied user-agent string.

This verification covers the fresh sample only. Re-fetching the original 15:55–15:58 interval failed twice with a Railway query error, so the original 17 requests have not individually undergone this check. Nor does verifying 32 requests establish that Semrush generated the historical 225,300 rejected clicks. The newer sample also contained 99 requests claiming Amazonbot; those source identities were not verified in this follow-up.

The past week's bot-classified rejected clicks span 119,932 distinct impression IDs, 210 campaigns, three publisher slots, and 4,427 rotating IP hashes. The largest hash accounts for 438 attempts; the top ten account for about 3% of the total. Rotating hashes are not unique people or a reliable count of distinct physical IPs. None of these bot-classified click rows has a visitor ID.

Impressions show a separate repeat-fetch pattern: 471,694 raw free-tier impression records in the past week, of which 424,215 were marked duplicate and 47,479 counted as non-duplicate delivery. This is not a click count or proof of malicious intent, but reinforces the need to distinguish crawler/repeated fetches from audience demand.

The evidence supports substantial automated crawling of ad links. It does **not** establish a coordinated malicious click-fraud campaign. The main demonstrated harms are inflated event volume, misleading reporting, and unnecessary processing; the rejected rows show no cash loss.

## Existing protection and remaining gaps

Production already includes the September 13 change `4bc6ad3`, which adds an atomic five-second Redis cooldown across campaigns and app instances. The current fraud checks also deduplicate accepted paid and free clicks over six hours. These protections precede this investigation.

The cooldown is claimed only after a click passes the earlier checks. A bot-classified click is rejected first, but still writes a rejected-click row and resolves a redirect. The accepted-click cooldown therefore does not throttle all incoming bot requests or their database writes. This explains why billing protection and a large rejected-attempt count can coexist.

The production `ad_clicks` table has no persisted rejection-reason field. Of the past week's 136,883 rejected attempts, 103 are classified as desktop rather than bot. Existing rows cannot reliably distinguish duplicate, cooldown, forged, unavailable-campaign, or validation failure outcomes for those requests.

## Recommended repair order

1. Replace the lifetime workaround with an explicitly owner-scoped, date-scoped reporting query that works for API-token callers and uses the existing rollups where appropriate. Return billed, accepted free, and rejected clicks separately, using the same scope and window for totals and domain rows. Preserve and expose query failures so missing data cannot masquerade as zero.
2. Base CTR and property scoring on trustworthy, consistently scoped delivery; label free delivery separately from cash revenue. Keep last-known-good results visibly dated when a refresh fails. The current ad figures cannot support reliable monetization or property-potential conclusions.
3. Reduce repeated known-crawler work on ad short links and apply request limits before expensive click processing where justified. Preserve useful aggregate bot diagnostics without recording every repeated request as an individual click event. Avoid blanket blocking feed access on the strength of this sample alone.
4. Persist a bounded rejection-reason enum and aggregate source/classifier diagnostics. This will distinguish routine crawling, duplicate clicks, rate-limit rejection, and suspicious abuse, and make subsequent fixes measurable.

Verification used the live earnings API, deployed source, production database definitions and aggregates, isolated REST view probes, and Railway HTTP logs. Database inspection used read-only transactions; credentials and raw visitor identifiers are excluded from this report.
