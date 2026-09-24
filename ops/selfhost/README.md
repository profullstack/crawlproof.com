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

```sh
CLOUD_DB_URL='postgres://postgres.ywcizjsgrcmhgyplldac:<pw>@<pooler-host>:5432/postgres' \
  ops/selfhost/migrate/pull-cloud.sh ~/crawlproof-dump
```

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

### 7. DNS

See the table in the migration report. Apex and `www` come off Railway last,
after everything above verifies against a `Host:` header.

## Redis and the prober

`scan.crawlproof.com` (164.92.111.224) is a DigitalOcean droplet running the
nmap prober as a BullMQ consumer. It connects **outbound** to Redis using the
`PROBER_REDIS_URL` repo secret, which today points at Railway. After the move
that secret has to be repointed at dev2, and ufw opened to that one address —
the Redis port is on loopback by default.

This repo's default branch is **`master`**, not `main`. `deploy-prober.yml` and
`deploy-dev2.yml` both watch `master` for that reason, and `deploy-app.sh`
resolves a ref through `origin/<ref>` before checking it out, because a bare
branch name that does not exist locally fails with the thoroughly unhelpful
"git checkout: --detach does not take a path argument".
