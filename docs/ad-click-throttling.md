# Ad click throttling

A visitor or IP may produce one accepted ad click per five seconds across the
network. The cooldown covers every campaign and publisher, including promotional
and paper-auction clicks. A repeated click still redirects to the advertiser, but
is recorded as invalid: no advertiser debit, publisher accrual or paper spend.

An atomic Redis script claims both the salted IP and visitor buckets together.
The keys expire after five seconds and rejected attempts do not extend that
expiry. Using a shared Redis instance prevents simultaneous requests handled by
different app instances from passing the same cooldown. Changing only a cookie
or only an IP does not reset the other bucket. People sharing an IP also share
this short cooldown.

The existing six-hour campaign deduplication also covers legitimate free-tier
delivery. Invalid bot traffic does not count as prior delivery. Missing identity
and failed validation withhold billing. During a Redis outage, redirects continue
and all cash and paper charges are withheld; an availability warning is logged
at most once a minute per process. Configure `REDIS_URL` and `IP_HASH_SALT` on
every app instance before deploying.

On Railway, click accounting uses the edge-provided `X-Real-IP`, rather than
letting a caller-supplied Cloudflare header replace it. See the
[Railway request-header contract](https://docs.railway.com/networking/public-networking/specs-and-limits).

Run the concurrency tests against a disposable Redis instance:

```sh
TEST_AD_REDIS_URL=redis://127.0.0.1:6379 npm test
```

These tests use unique temporary keys and cover concurrent connections, expiry,
cookie/IP changes, rejection without extending the window, failed validation
and every accounting tier. `TEST_AD_REDIS_URL` is deliberately separate from
the application's `REDIS_URL`.
