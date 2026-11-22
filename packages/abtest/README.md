# @profullstack/abtest

A/B tests for any product, with the stats kept on [CrawlProof](https://crawlproof.com/dashboard/experiments).

- **Sticky, deterministic assignment.** `assignArm(experiment, unit, arms)` hashes the experiment key and the unit id, so the server and every client agree on a unit's arm. When CrawlProof cannot be reached, `assign()` computes the same arm locally (`offline: true`) and your product keeps working.
- **Events.** `exposure` (the unit saw the treatment: the conversion denominator), `conversion`, `revenue` (an amount) and named engagement `event`s. Pass `id` as an idempotency key and retries count once.
- **Stats.** For each arm: the conversion rate with a 95% Wilson interval, the lift against the control, a pooled two-proportion z test, the Bayesian probability that the arm beats the control (exact Beta posterior comparison), revenue per exposed unit, and named events. The verdict line is in plain language and tells you how many units per arm the observed gap needs before it can be called.
- **Advice built in.** Run two arms and judge on conversions. On small traffic only big gaps settle. Nothing is read until every arm has `min_per_arm` exposed units (default 100).

## Use it from a product

```js
import { createClient } from "@profullstack/abtest";

const ab = createClient({ token: process.env.CRAWLPROOF_TOKEN }); // a crp_ token from crawlproof.com/dashboard/api-tokens
const ARMS = ["90d", "30d"];

await ab.experiment({ key: "trial-length", name: "Trial length", arms: ARMS, control: "90d" }); // safe on every boot

const { arm } = await ab.assign("trial-length", account.id, ARMS); // store it with the account
await ab.exposure("trial-length", account.id, { arm, id: `exposure:${account.id}` });
await ab.event("trial-length", account.id, "voice_meeting", { id: `meeting:${meeting.id}` });
await ab.conversion("trial-length", account.id, { id: `paid:${payment.id}` });
await ab.revenue("trial-length", account.id, 19, { id: `revenue:${payment.id}` });
```

Send opaque unit ids, such as account ids, and never send emails. CrawlProof stores only `sha256(experiment || unit)`.

## Read results

- Dashboard: `https://crawlproof.com/dashboard/experiments/<key>`
- API: `GET /api/abtest/v1/experiments/<key>` (a read-only `stats:read` token works)
- CLI: `CRAWLPROOF_TOKEN=crp_… npx @profullstack/abtest stats <key>` or `abtest list`

To stop an experiment, send `PATCH /api/abtest/v1/experiments/<key>` with `{"status":"stopped","winner":"30d"}`. After that, `assign` returns the winner to everyone and records nothing.

## Stats only

```js
import { summarize, sampleSizePerArm } from "@profullstack/abtest";
summarize([{ arm: "a", exposed: 1000, converted: 50 }, { arm: "b", exposed: 1000, converted: 80 }]).verdict.text;
sampleSizePerArm(0.05, 0.08); // units per arm for alpha 0.05, power 0.8
```

## API

| Method | Path | Body |
| --- | --- | --- |
| GET | `/api/abtest/v1/experiments` | |
| POST | `/api/abtest/v1/experiments` | `{ key, name?, description?, arms, control?, min_per_arm? }` |
| GET | `/api/abtest/v1/experiments/:key` | returns the experiment, `summary` and verdict |
| PATCH | `/api/abtest/v1/experiments/:key` | `{ status?, winner?, name?, description? }` |
| POST | `/api/abtest/v1/assign` | `{ experiment, unit }` returns `{ arm, new }` |
| POST | `/api/abtest/v1/events` | `{ experiment, unit, type, name?, value?, arm?, id? }`, or `{ events: [...] }` with up to 100 |

Every call sends `Authorization: Bearer crp_…`. MIT licensed.
