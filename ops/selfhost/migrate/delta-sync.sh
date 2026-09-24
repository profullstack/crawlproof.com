#!/usr/bin/env bash
#
# Backfill what the CLOUD database recorded between the dump and the DNS
# cutover. Only analytics moves in that window — a dump at T and a cutover an
# hour later leaves an hour of ad impressions and tracker rollups behind, and
# nothing else (no new users, audits, articles or posts, which is worth
# re-checking rather than assuming).
#
# Run from a machine that can reach both: the cloud over its pooler and dev2
# over ssh. Idempotent — re-running only adds what is still missing.
#
#   CLOUD_DB_URL=postgres://... ops/selfhost/migrate/delta-sync.sh '2026-09-24 19:18:00+00'
#
set -euo pipefail

SINCE=${1:?usage: delta-sync.sh <since-timestamptz>}
CLOUD_DB_URL=${CLOUD_DB_URL:?set CLOUD_DB_URL}
SSH_TARGET=${SSH_TARGET:-root@dev2.profullstack.com}
PG_IMAGE=${PG_IMAGE:-postgres:17}
WORK=${WORK:-$(mktemp -d)}

log() { printf '\n===> %s\n' "$*"; }

cloud_copy() { # cloud_copy <sql> <outfile>
  docker run --rm -i "$PG_IMAGE" psql "$CLOUD_DB_URL" -X -v ON_ERROR_STOP=1 \
    -c "\\copy ($1) to stdout with (format csv, header true)" > "$2"
}

remote_psql() { ssh -o BatchMode=yes "$SSH_TARGET" "docker exec -i supabase-db psql -U postgres -h localhost -d postgres -X -v ON_ERROR_STOP=1 $*"; }

# \copy is a psql meta-command: it cannot appear inside a multi-statement -c,
# which fails with `syntax error at or near "\"`. Feeding a script on stdin
# keeps it one session, so the temp table is still there when the copy and the
# insert run. The CSV goes in on the same stdin via `\copy ... from stdin`.
remote_load() { # remote_load <table> <csv> <sql-after-copy>
  local tbl=$1 csv=$2 after=$3
  {
    printf 'create temp table t_%s (like public.%s including defaults);\n' "$tbl" "$tbl"
    printf '\\copy t_%s (%s) from stdin with (format csv, header true)\n' "$tbl" "$(head -1 "$csv")"
    cat "$csv"
    printf '\\.\n'
    printf '%s\n' "$after"
  } | ssh -o BatchMode=yes "$SSH_TARGET" \
      "docker exec -i supabase-db psql -U postgres -h localhost -d postgres -X -v ON_ERROR_STOP=1 -f -"
}

# ad_impressions is append-only with a surrogate PK, so conflicting rows are
# rows we already have and skipping them is exactly right.
sync_append_only() { # sync_append_only <table> <time-column>
  local tbl=$1 tcol=$2
  log "$tbl since $SINCE"
  cloud_copy "select * from public.$tbl where $tcol > '$SINCE'" "$WORK/$tbl.csv"
  local rows
  rows=$(( $(wc -l < "$WORK/$tbl.csv") - 1 ))
  echo "  $rows rows from cloud"
  [ "$rows" -gt 0 ] || return 0

  remote_load "$tbl" "$WORK/$tbl.csv" \
    "insert into public.$tbl select * from t_$tbl on conflict do nothing;"
}

# The tracker rollups are counters keyed by (project, day, ...). The cloud's
# value is authoritative for everything up to the cutover, and dev2 has barely
# started counting, so overwriting the touched rows right after the flip is
# both simpler and more accurate than trying to add deltas.
sync_rollup() { # sync_rollup <table> <conflict-cols>
  local tbl=$1 keys=$2
  log "$tbl since $SINCE (overwrite touched rows)"
  cloud_copy "select * from public.$tbl where updated_at > '$SINCE'" "$WORK/$tbl.csv"
  local rows
  rows=$(( $(wc -l < "$WORK/$tbl.csv") - 1 ))
  echo "  $rows rows from cloud"
  [ "$rows" -gt 0 ] || return 0

  local setlist
  setlist=$(head -1 "$WORK/$tbl.csv" | tr ',' '\n' \
    | grep -vxF -f <(printf '%s' "$keys" | tr ',' '\n') \
    | sed 's/^\(.*\)$/\1 = excluded.\1/' | paste -sd, -)
  remote_load "$tbl" "$WORK/$tbl.csv" \
    "insert into public.$tbl select * from t_$tbl on conflict ($keys) do update set $setlist;"
}

log "Confirming nothing but analytics moved in the window"
docker run --rm -i "$PG_IMAGE" psql "$CLOUD_DB_URL" -X -At -c "
  select 'users='||(select count(*) from auth.users where created_at > '$SINCE')
     ||' audits='||(select count(*) from public.audits where created_at > '$SINCE')
     ||' articles='||(select count(*) from public.lx_article where created_at > '$SINCE')
     ||' posts='||(select count(*) from public.promo_post where created_at > '$SINCE')"

sync_append_only ad_impressions ts
sync_rollup tracker_daily_stats 'project_id,day,bucket'
sync_rollup tracker_event_daily_stats 'project_id,day,event,page_path,referrer_host,event_target,kind'

log "Counts on dev2 now"
remote_psql -At -c "\"select 'ad_impressions='||(select count(*) from public.ad_impressions)
  ||' tracker_daily='||(select count(*) from public.tracker_daily_stats)
  ||' tracker_events='||(select count(*) from public.tracker_event_daily_stats)\""
