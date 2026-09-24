# crawlproof.com off Railway + Supabase cloud, onto dev2

Moves the whole of crawlproof.com to `dev2.profullstack.com` (23.95.228.174):
the Next.js app, the audit worker, the Redis the prober queue needs, and a
self-hosted Supabase instance replacing the cloud project `ywcizjsgrcmhgyplldac`.

Everything lands under `/home/anthony/www/crawlproof.com`, which is the house
docroot for migrated and new apps on this box.

```
/home/anthony/www/crawlproof.com/
├── app/                        the repo checkout CI builds from
├── supabase/                   the self-hosted Supabase stack (root-owned)
├── docker-compose.app.yml      app + redis
├── app.env                     the app's secrets   (0600)
├── deploy.env                  ports and build args
├── deploy-app.sh               what CI calls over ssh
└── volumes/redis/
```

## What is being replaced

| Piece | Was | Becomes |
| --- | --- | --- |
| App + audit worker | Railway service `crawlproof.com` (one container) | `crawlproof-app` on dev2 behind nginx |
| Postgres + Auth + Storage + Realtime | Supabase cloud `ywcizjsgrcmhgyplldac` (us-west-1) | self-hosted Supabase, `supabase.crawlproof.com` |
| Redis (prober queue) | `redis.railway.internal` | `crawlproof-redis` on dev2 |
| Deploys | Railway watching the GitHub repo | `.github/workflows/deploy-dev2.yml` |

Scale being moved: **5.0 GB** database, 128 tables, 204 functions, 45 triggers,
113 auth users, **9.8 GB** of Storage in 8,390 objects across 5 buckets, and
**10 pg_cron jobs** that `net.http_post` back into the app.

## Runbook

All of it is idempotent. Re-running a step is how you fix a half-finished one.

### 1. The box

```sh
scp ops/selfhost/server/setup-supabase.sh root@dev2.profullstack.com:/root/
ssh root@dev2.profullstack.com 'SMTP_PASS=<resend key> bash /root/setup-supabase.sh'
```

Stands up the pinned `self-hosted/v0.8.2` Supabase stack, tunes Postgres for the
box, gives it a TLS cert and a `pg_hba` that only lets `postgres` in from
outside and only over TLS, creates the extensions crawlproof's schema needs
(`pg_cron`, `pg_net`, `vector`, `pgcrypto`, `uuid-ossp`), and writes
`supabase/crawlproof-connection.env` with the new keys.

Two things it deliberately does NOT do, both of which the nichedb kit this was
adapted from does:

- **No `lock_down_public`.** nichedb serves its own API and revokes `anon` and
  `authenticated` from `public`. crawlproof talks to PostgREST with those exact
  roles and guards rows with RLS, so revoking them would take the app offline.
  `check_postgres` asserts the opposite of nichedb's check for that reason.
- **No Caddy.** dev2 already terminates TLS with nginx for every other vhost.
  The gateway is published on `127.0.0.1:8000` and nginx proxies to it.

### 2. Dump the cloud

From anywhere with the cloud credentials (read-only, safe to rehearse):

`CLOUD_DB_URL` is a normal Postgres connection string for the cloud project.
Keep it out of your shell history and out of this file — read it from the vault
into the environment instead of pasting it:

```sh
export CLOUD_DB_URL="$(logicsrc teams secrets crawlproof --get SUPABASE_POOLER_URL)"
ops/selfhost/migrate/pull-cloud.sh ~/crawlproof-dump
```

Two details about that URL, since they are not guessable: the user is
`postgres.<project-ref>`, and the host must be the **session** pooler
(`aws-1-us-west-1.pooler.supabase.com`, port 5432). `aws-0-…` answers for other
projects and returns `Tenant or user not found`, and the direct
`db.<ref>.supabase.co` host is IPv6-only. pg_dump needs session mode, so 6543
(transaction mode) will not do.

Produces `schema.sql`, `data.sql`, `cron-jobs.sql`, `realtime.sql`,
`buckets.tsv`, `storage-inventory.tsv` and a `MANIFEST`.

`storage.objects` and `tracker_events` are excluded from the data dump on
purpose — the first is rewritten by the Storage API during the file sync, the
second is raw and pruned at 24h anyway.

### 3. Load it

```sh
scp -r ~/crawlproof-dump root@dev2.profullstack.com:/root/
ssh root@dev2.profullstack.com 'bash /root/load-selfhost.sh /root/crawlproof-dump'
```

Loads `public` only from the dump — the stack's own `auth` and `storage`
schemas are already at the version the running images expect, and replaying the
cloud's copy over them fights the service migrations. `auth` and `storage`
contribute rows, not DDL.

It also snapshots row counts before and after, recreates the realtime
publication and the 10 cron jobs, and **rewrites the 2,928 rows that store
absolute `https://ywcizjsgrcmhgyplldac.supabase.co` storage URLs**
(`ad_creatives` 1,956, `lx_article` 617, `sp_feed_item` 307, `blog_posts` 48).
Those would 404 forever once the cloud project is deleted.

### 4. Move the files

```sh
CLOUD_URL=https://ywcizjsgrcmhgyplldac.supabase.co CLOUD_SERVICE_KEY=... \
SELF_URL=https://supabase.crawlproof.com SELF_SERVICE_KEY=... \
  node ops/selfhost/migrate/sync-storage.mjs ~/crawlproof-dump --concurrency 8
```

Resumable: an object already present at the same size is skipped, so a re-run
after a failure moves only what is missing. Failures are appended to
`storage-sync-failures.log`.

### 5. The app

`app.env` is rendered from the vault (not committed, not in `.env`), then:

```sh
ssh anthony@dev2.profullstack.com '/home/anthony/www/crawlproof.com/deploy-app.sh main'
```

`deploy-app.sh --status` shows what is live; `--rollback` returns to the
previously deployed sha. A deploy that fails its health check restores the
previous container rather than leaving the site down.

### 6. nginx + certificates

```sh
cp ops/selfhost/server/nginx-crawlproof.conf /etc/nginx/sites-available/crawlproof.com
ln -s ../sites-available/crawlproof.com /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
certbot --nginx -d supabase.crawlproof.com
certbot --nginx -d crawlproof.com -d www.crawlproof.com   # only once DNS points here
```

`supabase.crawlproof.com` can be certified immediately — it is a new name. The
apex and `www` cannot be certified over HTTP-01 until DNS moves, so either
accept a short TLS gap at cutover or pre-issue over DNS-01 with the Porkbun API.

### 7. DNS and the cutover

Done 2026-09-24. What changed at Porkbun:

| Host | Was | Now |
| --- | --- | --- |
| `crawlproof.com` | ALIAS → `h1krorli.up.railway.app` | A → 23.95.228.174 |
| `www.crawlproof.com` | CNAME → `8gjlucle.up.railway.app` | CNAME → `crawlproof.com` |
| `supabase.crawlproof.com` | — | A → 23.95.228.174 |
| `db.crawlproof.com` | — | A → 23.95.228.174 |
| `_railway-verify` ×2 | TXT | deleted |

`scan.crawlproof.com`, MX, SPF, DKIM and DMARC were not touched.

The apex certificate is pre-issued over DNS-01 with acme.sh against the Porkbun
API (`ops/selfhost` has the script), so TLS was already serving before the flip
and there was no gap. acme.sh renews it and reloads nginx; certbot separately
owns `supabase.crawlproof.com`.

Order that matters, because two databases can otherwise drive the same app:

1. flip DNS
2. `migrate/delta-sync.sh '<dump time>'` — backfills what the cloud recorded
   between the dump and the flip (analytics only: ad impressions and tracker
   rollups; verify nothing else moved, the script checks)
3. unschedule the **cloud** project's cron jobs — they post to
   `crawlproof.com`, which now resolves here
4. `migrate/unpark-cron.sh` — enables the self-hosted jobs, and refuses to run
   unless crawlproof.com already resolves to dev2
5. remove the Railway deployments **and disconnect the repo watch**, or the
   next push to master silently redeploys it

### 8. CI

`.github/workflows/deploy-dev2.yml` ssh's in as `anthony` and runs
`deploy-app.sh`. Secrets: `DEV2_SSH_KEY`, `DEV2_HOST`, `DEV2_USER`,
`DEV2_KNOWN_HOSTS`. The deploy account can read `app.env` and use docker, but
**not** `supabase/.env` — that directory stays root-owned because it holds the
database's God Mode keys and a deploy has no business reading them.

## Network posture

What dev2 exposes to the internet, and why:

| Port | Open to | Why |
| --- | --- | --- |
| 22 | everyone | ssh |
| 80 / 443 | everyone | nginx: the app, and the Supabase gateway |
| 5432 | **allowlist** | Postgres, for the dev box only |
| 6379 | **nobody** | Redis is loopback; the prober tunnels in |
| 8000, 3100 | nobody | gateway and app, loopback behind nginx |

Two rules of thumb the hard way:

- **ufw does not gate a published Docker port.** Docker inserts its own
  iptables rules ahead of ufw's chains, so a ufw rule for a container port is
  decoration. `DOCKER-USER` is the chain Docker consults first and leaves
  alone; `restrict-data-ports.sh` puts the 5432 allowlist there and persists it
  to `/etc/iptables/rules.v4`.
- **The allowlist has to include `172.16.0.0/12`**, not just this stack's
  subnet. Other apps on the box run in their own compose projects on their own
  bridges and reach Postgres through the published port, so they arrive from a
  different docker subnet and a narrow allowlist cuts them off the moment they
  start.

`pg_hba` is the other half and is deliberately unchanged by any of this: TLS
required, `postgres` role only, scram.

Admin access is **Supabase Studio at `https://supabase.crawlproof.com`**,
behind HTTP basic auth (`DASHBOARD_USERNAME` / `DASHBOARD_PASSWORD` in
`supabase/.env`). It rides the existing TLS, so there is no separate admin port
to open.

## Redis and the prober

`scan.crawlproof.com` (164.92.111.224) is a DigitalOcean droplet running the
nmap prober as a BullMQ consumer, and it is the **only** remote consumer of
anything on dev2. It stays on its own droplet deliberately: it port-scans
customer sites, and doing that from the box that serves crawlproof.com would
put the app's own address behind the scanning traffic.

Rather than open Redis to it, it tunnels:

```sh
# on the prober, once
ssh-keygen -t ed25519 -N '' -f ~/.ssh/id_ed25519_dev2
# on dev2, with that public key
ops/selfhost/server/authorize-prober-tunnel.sh "$(cat ~/.ssh/id_ed25519_dev2.pub)"
# back on the prober
ops/selfhost/server/prober-redis-tunnel.sh
```

`PROBER_REDIS_URL` then points at `redis://default:<pw>@127.0.0.1:6380`.

Two things that will catch you:

- **The prober droplet already runs its own `redis-server` on 6379.** The
  tunnel therefore binds **6380** locally. Using 6379 either fails to bind or,
  worse, silently points the prober at the wrong Redis.
- The key on dev2 is
  `restrict,port-forwarding,permitopen="127.0.0.1:6379",command="/bin/false"`,
  so it cannot open a shell or reach any other port. `restrict` turns
  everything off including forwarding, which is why `port-forwarding` has to be
  listed again after it.

This repo's default branch is **`master`**, not `main`. `deploy-prober.yml` and
`deploy-dev2.yml` both watch `master` for that reason, and `deploy-app.sh`
resolves a ref through `origin/<ref>` before checking it out, because a bare
branch name that does not exist locally fails with the thoroughly unhelpful
"git checkout: --detach does not take a path argument".
