#!/usr/bin/env bash
#
# Dump the crawlproof Supabase CLOUD project so it can be loaded into the
# self-hosted stack on dev2. Read-only against the cloud — run it as often as
# you like, including for a dress rehearsal.
#
# Three dumps, in the order Supabase supports for a project move:
#   roles.sql   role definitions (passwords are not recoverable; see below)
#   schema.sql  every schema's DDL
#   data.sql    the rows, as COPY
#
# auth.users and auth.identities must load BEFORE public, or the foreign keys
# from public tables to auth.users fail. `supabase db dump --data-only` already
# emits auth before public because it walks schemas in dependency order, but
# load-selfhost.sh checks rather than trusting it.
#
# Usage:
#   CLOUD_DB_URL=postgres://... ops/selfhost/migrate/pull-cloud.sh [outdir]
#
# The pooler URL is the one that works from outside; direct :5432 to
# db.<ref>.supabase.co is IPv6-only on this project.
#
set -euo pipefail

OUT=${1:-$HOME/crawlproof-cloud-dump-$(date +%Y%m%d-%H%M%S)}
CLOUD_DB_URL=${CLOUD_DB_URL:-}
PG_IMAGE=${PG_IMAGE:-postgres:17}

[ -n "$CLOUD_DB_URL" ] || { echo "ERROR: set CLOUD_DB_URL" >&2; exit 1; }

log() { printf '\n===> %s\n' "$*"; }

mkdir -p "$OUT"
chmod 700 "$OUT"

# The local pg_dump must not be older than the server (17.6), and this box may
# have anything installed, so dump through a pinned container instead.
pgdump() { docker run --rm -i "$PG_IMAGE" pg_dump "$@"; }

log "Schema (public only)"
# Deliberately NOT auth or storage. The self-hosted stack's GoTrue and Storage
# services create and migrate their own schemas to match the images that are
# running, and those versions are not the cloud's. Replaying the cloud's DDL
# over them fights the service migrations. auth and storage contribute rows
# (below), never structure.
pgdump --dbname="$CLOUD_DB_URL" \
  --schema-only --no-owner --no-privileges --quote-all-identifiers \
  --schema=public \
  > "$OUT/schema.sql"

log "Data"
# --disable-triggers keeps FK order from mattering during the load; it needs
# superuser, which `postgres` is on the self-hosted side.
pgdump --dbname="$CLOUD_DB_URL" \
  --data-only --no-owner --no-privileges --quote-all-identifiers \
  --disable-triggers \
  --schema=auth --schema=public --schema=storage \
  --exclude-table-data='storage.objects' \
  --exclude-table-data='storage.migrations' \
  --exclude-table-data='auth.schema_migrations' \
  --exclude-table-data='public.tracker_events' \
  > "$OUT/data.sql"

# Four exclusions, each for its own reason:
#
# storage.objects      sync-storage.mjs re-uploads the files through the
#                      Storage API, which writes these rows itself. Importing
#                      the cloud's copy as well would leave metadata pointing
#                      at files the self-hosted backend has never heard of.
# storage.migrations   the storage service's own schema-version ledger. Load
# auth.schema_migrations  the cloud's rows and the self-hosted service believes
#                      it has already run migrations that its images have not,
#                      and silently skips them.
# public.tracker_events  raw hit log, pruned at 24h, worth nothing after a move.

log "pg_cron jobs (not in a schema dump; they live in the cron schema)"
docker run --rm -i "$PG_IMAGE" psql "$CLOUD_DB_URL" -At -X -v ON_ERROR_STOP=1 \
  -c "select 'select cron.schedule(' || quote_literal(jobname) || ', ' || quote_literal(schedule) || ', ' || quote_literal(command) || ');' from cron.job where active order by jobid" \
  > "$OUT/cron-jobs.sql"

log "Realtime publication membership"
docker run --rm -i "$PG_IMAGE" psql "$CLOUD_DB_URL" -At -X -v ON_ERROR_STOP=1 \
  -c "select 'alter publication supabase_realtime add table ' || string_agg(format('%I.%I', schemaname, tablename), ', ') || ';' from pg_publication_tables where pubname='supabase_realtime'" \
  > "$OUT/realtime.sql"

log "Storage inventory (what sync-storage.mjs has to move)"
docker run --rm -i "$PG_IMAGE" psql "$CLOUD_DB_URL" -At -F$'\t' -X -v ON_ERROR_STOP=1 \
  -c "select b.id, b.public, o.name, coalesce((o.metadata->>'size')::bigint,0), coalesce(o.metadata->>'mimetype','application/octet-stream') from storage.buckets b join storage.objects o on o.bucket_id=b.id order by b.id, o.name" \
  > "$OUT/storage-inventory.tsv"

log "Bucket definitions"
docker run --rm -i "$PG_IMAGE" psql "$CLOUD_DB_URL" -At -F$'\t' -X -v ON_ERROR_STOP=1 \
  -c "select id, name, public, coalesce(file_size_limit::text,''), coalesce(array_to_string(allowed_mime_types,','),'') from storage.buckets order by id" \
  > "$OUT/buckets.tsv"

{
  echo "dumped_at=$(date -u +%FT%TZ)"
  echo "schema_bytes=$(stat -c%s "$OUT/schema.sql")"
  echo "data_bytes=$(stat -c%s "$OUT/data.sql")"
  echo "storage_objects=$(wc -l < "$OUT/storage-inventory.tsv")"
  # Job bodies are multi-line and at least one mentions cron.schedule itself,
  # so count statement starts, not matching lines.
  echo "cron_jobs=$(grep -c '^select cron.schedule' "$OUT/cron-jobs.sql" || true)"
} > "$OUT/MANIFEST"

log "Done: $OUT"
cat "$OUT/MANIFEST"
