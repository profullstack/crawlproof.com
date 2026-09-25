#!/usr/bin/env bash
# Prove the 7-day rolling retention does what it says, without waiting a week.
# Uses a scratch directory so real backups are never at risk.
set -uo pipefail
T=/tmp/rettest
rm -rf "$T"; mkdir -p "$T"

mk() { : > "$T/$1"; touch -d "$2" "$T/$1"; }

# Frequent dumps: one fresh, one 3 days old, one 9 days old.
mk 'postgres-20260925-000000.dump' 'now'
mk 'postgres-20260922-000000.dump' '3 days ago'
mk 'postgres-20260916-000000.dump' '9 days ago'
# Fulls: one 2 days old, one 9 days old, one 30 days old. The 9 and 30 day
# ones are expired, but if BOTH went the database would have no full at all —
# the newest must survive regardless of age.
mk 'nichedb-full-20260923-000000.dump' '2 days ago'
mk 'nichedb-full-20260916-000000.dump' '9 days ago'
mk 'nichedb-full-20260826-000000.dump' '30 days ago'
# A database whose every full is expired: the newest must still be kept.
mk 'rssamplifier-full-20260901-000000.dump' '24 days ago'
mk 'rssamplifier-full-20260820-000000.dump' '36 days ago'

echo "before:"; ls -1 "$T" | sort | sed 's/^/  /'

OUT="$T"; KEEP_FREQUENT_DAYS=7; KEEP_FULL_DAYS=7
dbs="postgres nichedb rssamplifier"

find "$OUT" -name '*-[0-9]*.dump' ! -name '*-full-*' -mtime +"$KEEP_FREQUENT_DAYS" -delete 2>/dev/null
for db in $dbs; do
  newest=$(ls -1t "$OUT/${db}-full-"*.dump 2>/dev/null | head -1)
  while IFS= read -r old; do
    [ -n "$old" ] || continue
    [ "$old" = "$newest" ] && continue
    rm -f "$old"
  done < <(find "$OUT" -name "${db}-full-*.dump" -mtime +"$KEEP_FULL_DAYS" 2>/dev/null)
done

echo "after:"; ls -1 "$T" | sort | sed 's/^/  /'

echo
echo "expected:"
echo "  postgres fresh + 3d kept, 9d gone"
echo "  nichedb 2d kept, 9d and 30d gone"
echo "  rssamplifier 24d KEPT (newest, even though expired), 36d gone"
echo
fail=0
[ -f "$T/postgres-20260925-000000.dump" ] || { echo "FAIL fresh frequent deleted"; fail=1; }
[ -f "$T/postgres-20260922-000000.dump" ] || { echo "FAIL 3-day frequent deleted"; fail=1; }
[ -e "$T/postgres-20260916-000000.dump" ] && { echo "FAIL 9-day frequent survived"; fail=1; }
[ -f "$T/nichedb-full-20260923-000000.dump" ] || { echo "FAIL recent full deleted"; fail=1; }
[ -e "$T/nichedb-full-20260916-000000.dump" ] && { echo "FAIL 9-day full survived"; fail=1; }
[ -e "$T/nichedb-full-20260826-000000.dump" ] && { echo "FAIL 30-day full survived"; fail=1; }
[ -f "$T/rssamplifier-full-20260901-000000.dump" ] || { echo "FAIL newest full deleted despite being the only one"; fail=1; }
[ -e "$T/rssamplifier-full-20260820-000000.dump" ] && { echo "FAIL 36-day full survived"; fail=1; }
[ "$fail" = 0 ] && echo "ALL RETENTION ASSERTIONS PASSED"
rm -rf "$T"
