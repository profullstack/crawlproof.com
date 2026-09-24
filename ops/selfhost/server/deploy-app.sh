#!/usr/bin/env bash
#
# Deploy crawlproof.com on dev2. This is what GitHub Actions calls over ssh,
# and what you run by hand to roll forward or back.
#
#   deploy-app.sh <git-sha|ref>       build that revision and switch to it
#   deploy-app.sh --rollback          go back to the previously deployed sha
#   deploy-app.sh --status            what is deployed and healthy right now
#
# Builds happen on the box: the image needs NEXT_PUBLIC_* at build time and
# those come from app.env, which never leaves dev2.
#
set -euo pipefail

ROOT=${ROOT:-/home/anthony/www/crawlproof.com}
APP_DIR="$ROOT/app"
REPO=${REPO:-https://github.com/profullstack/crawlproof.com.git}
APP_PORT=${APP_PORT:-3100}
HEALTH_TIMEOUT=${HEALTH_TIMEOUT:-300}
STATE="$ROOT/.deploy-state"

log() { printf '\n===> %s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

compose() { (cd "$ROOT" && docker compose -f docker-compose.app.yml --env-file "$ROOT/deploy.env" "$@"); }

health() {
  local i
  for i in $(seq 1 "$((HEALTH_TIMEOUT / 5))"); do
    if curl -fsS -m 5 -o /dev/null "http://127.0.0.1:${APP_PORT}/"; then return 0; fi
    sleep 5
  done
  return 1
}

case "${1:-}" in
  --status)
    compose ps
    curl -fsS -m 5 -o /dev/null -w 'app http %{http_code} in %{time_total}s\n' "http://127.0.0.1:${APP_PORT}/" || echo "app not answering"
    [ -f "$STATE" ] && cat "$STATE"
    exit 0
    ;;
  --rollback)
    [ -f "$STATE" ] || die "no deploy state to roll back to"
    # shellcheck disable=SC1090
    . "$STATE"
    [ -n "${PREVIOUS_SHA:-}" ] || die "no PREVIOUS_SHA recorded"
    log "Rolling back to $PREVIOUS_SHA"
    exec "$0" "$PREVIOUS_SHA"
    ;;
esac

TARGET=${1:?usage: deploy-app.sh <git-sha|ref> | --rollback | --status}

[ -f "$ROOT/app.env" ] || die "missing $ROOT/app.env (the app's secrets)"
[ -f "$ROOT/deploy.env" ] || die "missing $ROOT/deploy.env (ports, build args)"

CURRENT=""
[ -d "$APP_DIR/.git" ] && CURRENT=$(git -C "$APP_DIR" rev-parse HEAD 2>/dev/null || echo "")

if [ ! -d "$APP_DIR/.git" ]; then
  log "First deploy: cloning $REPO"
  git clone --filter=blob:none "$REPO" "$APP_DIR"
fi

log "Fetching $TARGET"
git -C "$APP_DIR" fetch --all --tags --prune

# Resolve to a sha before checking out. `git checkout --detach <ref>` reports
# the useless "--detach does not take a path argument" when the ref does not
# exist, and a bare branch name only resolves locally — this repo's default
# branch is master, so `main` is not a ref at all.
SHA=$(git -C "$APP_DIR" rev-parse --verify --quiet "origin/$TARGET^{commit}" \
   || git -C "$APP_DIR" rev-parse --verify --quiet "$TARGET^{commit}" \
   || true)
[ -n "$SHA" ] || die "cannot resolve '$TARGET' to a commit (origin/$TARGET does not exist either)"
git -C "$APP_DIR" checkout --detach "$SHA"
log "At $SHA"

log "Building"
compose build app

log "Starting"
compose up -d

if health; then
  log "Healthy"
  {
    echo "DEPLOYED_SHA=$SHA"
    echo "PREVIOUS_SHA=$CURRENT"
    echo "DEPLOYED_AT=$(date -u +%FT%TZ)"
  } > "$STATE"
  compose ps
else
  log "UNHEALTHY after ${HEALTH_TIMEOUT}s — last 60 lines:"
  compose logs --tail 60 app || true
  if [ -n "$CURRENT" ]; then
    log "Restoring $CURRENT"
    git -C "$APP_DIR" checkout --detach "$CURRENT"
    compose build app && compose up -d
    health && log "Restored to $CURRENT" || log "ROLLBACK ALSO UNHEALTHY — site is down"
  fi
  die "deploy of $SHA failed health check"
fi
