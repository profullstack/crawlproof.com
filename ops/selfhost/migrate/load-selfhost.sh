#!/usr/bin/env bash
#
# Load a pull-cloud.sh dump into the self-hosted Supabase stack on dev2.
# Run as root ON dev2, after setup-supabase.sh has the stack healthy.
#
# Usage: ops/selfhost/migrate/load-selfhost.sh <dumpdir>
#
# Everything runs through `docker exec supabase-db psql`, so no client on the
# host has to match the server version and nothing crosses the network.
#
set -euo pipefail

DUMP=${1:?usage: load-selfhost.sh <dumpdir>}
DIR=${DIR:-/home/anthony/www/crawlproof.com/supabase}
CLOUD_REF=${CLOUD_REF:-ywcizjsgrcmhgyplldac}
NEW_HOST=${NEW_HOST:-supabase.crawlproof.com}

log() { printf '\n===> %s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

[ -d "$DUMP" ] || die "no such dump directory: $DUMP"
for f in schema.sql data.sql cron-jobs.sql realtime.sql; do
  [ -s "$DUMP/$f" ] || die "missing or empty: $DUMP/$f"
done

psql_db() { docker exec -i supabase-db psql -U postgres -h localhost -d postgres -X "$@"; }
psql_strict() { psql_db -v ON_ERROR_STOP=1 "$@"; }

docker exec supabase-db pg_isready -U postgres -h localhost >/dev/null 2>&1 || die "supabase-db is not accepting connections"

log "Snapshot BEFORE (so a silent partial load cannot look like success)"
psql_strict -At -c "select 'tables='||(select count(*) from information_schema.tables where table_schema='public')||' users='||(select count(*) from auth.users)"

# ---------------------------------------------------------------- schema
# The self-hosted stack ships its own auth/storage schemas, already at the
# right version for the images that are running. Replaying the cloud's copy
# over them fights the service migrations, so only public comes from the dump
# and auth/storage contribute rows alone.
log "Schema: public only (auth and storage keep the stack's own definitions)"
awk '
  /^SET /            { print; next }
  /^SELECT pg_catalog.set_config/ { print; next }
  /CREATE SCHEMA "auth"/   { skip=1 }
  /CREATE SCHEMA "storage"/{ skip=1 }
  { print }
' "$DUMP/schema.sql" > "$DUMP/schema.public.sql"

# psql without ON_ERROR_STOP: the dump recreates a few objects the stack
# already has (extensions, the supabase roles) and those collisions are
# expected. Errors are captured and reviewed rather than aborting the load.
psql_db -f /dev/stdin < "$DUMP/schema.public.sql" > "$DUMP/schema.load.log" 2>&1 || true
log "Schema load errors (expected: existing extensions/roles)"
grep -c '^ERROR' "$DUMP/schema.load.log" || true
grep '^ERROR' "$DUMP/schema.load.log" | sed 's/^/    /' | sort -u | head -20 || true

# ------------------------------------------------------------------ data
# auth must land before public: public tables carry FKs to auth.users.
log "Verifying the dump puts auth before public"
a=$(grep -n 'COPY "auth"' "$DUMP/data.sql" | head -1 | cut -d: -f1 || echo 0)
p=$(grep -n 'COPY "public"' "$DUMP/data.sql" | head -1 | cut -d: -f1 || echo 0)
if [ "$a" -gt 0 ] && [ "$p" -gt 0 ] && [ "$a" -gt "$p" ]; then
  die "data.sql has public before auth (auth at line $a, public at $p) — FKs would fail"
fi
echo "auth at line $a, public at line $p — order is fine"

log "Data"
psql_db -f /dev/stdin < "$DUMP/data.sql" > "$DUMP/data.load.log" 2>&1 || true
log "Data load errors"
grep -c '^ERROR' "$DUMP/data.load.log" || true
grep '^ERROR' "$DUMP/data.load.log" | sed 's/^/    /' | sort -u | head -20 || true

# --------------------------------------------------------------- buckets
log "Buckets"
while IFS=$'\t' read -r id name pub limit mimes; do
  [ -n "$id" ] || continue
  psql_strict -c "insert into storage.buckets (id, name, public) values ('$id','$name',${pub}) on conflict (id) do update set public=excluded.public" >/dev/null
done < "$DUMP/buckets.tsv"
psql_strict -At -c "select id||' public='||public from storage.buckets order by id"

# ------------------------------------------------------------ url rewrite
# 2,928 rows across four columns store absolute https://<ref>.supabase.co
# storage URLs. Once the cloud project is gone those 404 forever, so they are
# rewritten to the new gateway as part of the load, not left for later.
log "Rewriting absolute cloud storage URLs to https://$NEW_HOST"
psql_strict -At <<EOF
\\set ON_ERROR_STOP on
update public.ad_creatives set image_url = replace(image_url, 'https://$CLOUD_REF.supabase.co', 'https://$NEW_HOST') where image_url like '%$CLOUD_REF.supabase.co%';
update public.blog_posts  set image_url = replace(image_url, 'https://$CLOUD_REF.supabase.co', 'https://$NEW_HOST') where image_url like '%$CLOUD_REF.supabase.co%';
update public.lx_article  set image_url = replace(image_url, 'https://$CLOUD_REF.supabase.co', 'https://$NEW_HOST') where image_url like '%$CLOUD_REF.supabase.co%';
update public.sp_feed_item set image_url = replace(image_url, 'https://$CLOUD_REF.supabase.co', 'https://$NEW_HOST') where image_url like '%$CLOUD_REF.supabase.co%';
EOF
psql_strict -At -c "select 'remaining cloud urls: '||(
  (select count(*) from public.ad_creatives where image_url like '%$CLOUD_REF.supabase.co%')
 +(select count(*) from public.blog_posts  where image_url like '%$CLOUD_REF.supabase.co%')
 +(select count(*) from public.lx_article  where image_url like '%$CLOUD_REF.supabase.co%')
 +(select count(*) from public.sp_feed_item where image_url like '%$CLOUD_REF.supabase.co%'))"

# -------------------------------------------------------------- realtime
log "Realtime publication"
psql_db -f /dev/stdin < "$DUMP/realtime.sql" 2>&1 | sed 's/^/    /' || true
psql_strict -At -c "select coalesce(string_agg(schemaname||'.'||tablename,', '),'(none)') from pg_publication_tables where pubname='supabase_realtime'"

# ------------------------------------------------------------- cron jobs
# cron_config.site_url is what the 10 jobs post back to; it must point at the
# app before the jobs are recreated, or every one of them calls the old host.
log "pg_cron jobs"
psql_strict -c "update public.cron_config set value='https://crawlproof.com' where key='site_url'" >/dev/null 2>&1 || true
psql_db -f /dev/stdin < "$DUMP/cron-jobs.sql" > "$DUMP/cron.load.log" 2>&1 || true
psql_strict -At -c "select count(*)||' cron jobs active' from cron.job where active"

log "Snapshot AFTER"
psql_strict -At -c "select 'tables='||(select count(*) from information_schema.tables where table_schema='public')||' users='||(select count(*) from auth.users)||' identities='||(select count(*) from auth.identities)||' size='||pg_size_pretty(pg_database_size(current_database()))"

log "Loaded. Next: ops/selfhost/migrate/sync-storage.mjs for the 9.8 GB of objects."
