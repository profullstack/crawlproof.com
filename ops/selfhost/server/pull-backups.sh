#!/usr/bin/env bash
#
# Pull dev2's database backups to this box, so a copy exists somewhere dev2's
# failure cannot reach.
#
# WHY THIS EXISTS. dev2 keeps 7 days of its own dumps, which covers a dropped
# table or a bad migration. It does not cover losing the box — and since
# crawlproof's Supabase cloud project was deleted on 2026-09-25, dev2 is
# otherwise the only place its data exists.
#
# WHY ONLY THE FREQUENT DUMPS. Those hold everything that cannot be
# re-derived: crawlproof complete, and nichedb/rssamplifier minus their bulk
# catalogue tables, which are re-importable from public sources. The daily
# FULL dumps are hundreds of GB and are not pulled — this box does not have
# room, and what they add is exactly the re-derivable part.
#
# PULL, not push: dev2 holds no credentials for this machine, so compromising
# dev2 does not reach the backups.
set -uo pipefail

REMOTE=${REMOTE:-root@dev2.profullstack.com}
SRC=${SRC:-/var/backups/postgres}
DEST=${DEST:-$HOME/backups/dev2}
KEEP_DAYS=${KEEP_DAYS:-7}
WARN_GB=${WARN_GB:-60}
LOG=${LOG:-$HOME/.local/state/pull-dev2-backups.log}

mkdir -p "$DEST" "$(dirname "$LOG")"
say() { echo "$(date -u '+%F %T') $*" >> "$LOG"; }

# Filter ORDER matters: rsync takes the first rule that matches, so the
# exclusions must come before `--include='*.dump'`. Getting this backwards
# silently pulls the very things it is meant to skip — the full dumps are
# hundreds of GB and would fill this box.
#
#   .*/          never descend into hidden dirs. dev2 has a .measure/ holding
#                an in-progress dump; pulling a partial file is worse than
#                useless because it looks like a backup.
#   *-full-*     the daily full dumps stay on dev2 by design; see the header.
#   --ignore-existing: dumps are immutable once written, so never re-transfer.
if rsync -a --ignore-existing --timeout=600 \
     --exclude='.*/' \
     --exclude='*-full-*' \
     --include='*/' --include='*.dump' --exclude='*' \
     -e 'ssh -o BatchMode=yes -o ConnectTimeout=20' \
     "$REMOTE:$SRC/" "$DEST/" >>"$LOG" 2>&1; then
  :
else
  say "FAILED rsync from $REMOTE"
  logger -t pull-dev2-backups -p daemon.err "rsync from dev2 failed" 2>/dev/null || true
  exit 1
fi

# A transferred dump is only a backup if it can be read. Verify the newest of
# each database with pg_restore, via docker so no local postgres is needed.
verified=0; bad=0
if command -v docker >/dev/null 2>&1; then
  for db in $(ls -1 "$DEST"/*.dump 2>/dev/null | xargs -r -n1 basename \
              | sed 's/-[0-9]\{8\}-[0-9]\{6\}\.dump$//' | sort -u); do
    newest=$(ls -1t "$DEST/${db}-"*.dump 2>/dev/null | head -1)
    [ -n "$newest" ] || continue
    if docker run --rm -i postgres:17 pg_restore --list < "$newest" >/dev/null 2>&1; then
      verified=$((verified + 1))
    else
      say "UNREADABLE $newest"
      logger -t pull-dev2-backups -p daemon.err "unreadable dump: $newest" 2>/dev/null || true
      bad=$((bad + 1))
    fi
  done
fi

find "$DEST" -name '*.dump' -mtime +"$KEEP_DAYS" -delete 2>/dev/null

n=$(ls -1 "$DEST"/*.dump 2>/dev/null | wc -l)
total=$(du -sh "$DEST" 2>/dev/null | cut -f1)
gb=$(du -s --block-size=1G "$DEST" 2>/dev/null | cut -f1)
avail=$(df -h --output=avail "$HOME" | tail -1 | tr -d ' ')
say "ok $n dumps, $total, ${verified} verified, ${bad} unreadable, $avail free here"

if [ "${gb:-0}" -ge "$WARN_GB" ]; then
  say "WARN off-box copies are using ${gb}GB (warn at ${WARN_GB}GB)"
  logger -t pull-dev2-backups -p daemon.warning "off-box backups ${gb}GB" 2>/dev/null || true
fi
[ "$bad" = 0 ]
