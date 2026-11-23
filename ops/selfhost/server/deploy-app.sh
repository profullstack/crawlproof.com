#!/usr/bin/env bash
#
# Deploy crawlproof.com on dev2. This is what GitHub Actions calls over ssh,
# and what you run by hand to roll forward or back.
#
#   deploy-app.sh <git-sha|ref>       build that revision and switch to it
#   deploy-app.sh --rollback          go back to the previously deployed sha
#   deploy-app.sh --status            what is deployed and healthy right now
#
# Prebuilt images (IMAGE_REPO in deploy.env): nothing is built here. The repo's
# deploy workflow builds the Dockerfile on GitHub Actions and pushes
# <IMAGE_REPO>:<full commit sha>; this script pulls that tag, points the app
# service at it (compose `image: ${APP_IMAGE:-crawlproofcom-app:latest}`) and runs
# `compose up --no-build`. A tag that is not in the registry stops the deploy before
# anything running is touched; it never falls back to a local build. Registry auth:
# one line on stdin (the workflow's short-lived GITHUB_TOKEN, read before the deploy
# gate), used once with a throwaway DOCKER_CONFIG and never stored.
# Without IMAGE_REPO the box builds, as before (NEXT_PUBLIC_* from deploy.env).
#
set -euo pipefail
if [ -z "${DEPLOY_GATED:-}" ] && [ ! -t 0 ] && [ -z "${DEPLOY_REGISTRY_TOKEN:-}" ] \
   && grep -q '^IMAGE_REPO=.' "$(dirname "$(readlink -f "$0")")/deploy.env" 2>/dev/null; then
  DEPLOY_REGISTRY_TOKEN=""
  IFS= read -r -t 5 DEPLOY_REGISTRY_TOKEN || true
  [[ $DEPLOY_REGISTRY_TOKEN =~ ^[A-Za-z0-9_.-]{20,400}$ ]] || DEPLOY_REGISTRY_TOKEN=""
  export DEPLOY_REGISTRY_TOKEN
fi
# Three deploys at a time on this box (@profullstack/deploy deploy-gate): a merge
# that lands with many others queues for a slot instead of building with all of them.
# No gate installed, a --status call, or already inside the gate: carry on as before.
if [ -z "${DEPLOY_GATED:-}" ] && [ "${1:-}" != --status ]; then
  for gate in /usr/local/bin/deploy-gate "$HOME/.local/bin/deploy-gate"; do
    [ -x "$gate" ] && exec "$gate" --name "$(basename "$(dirname "$(readlink -f "$0")")")" -- "$0" "$@"
  done
fi

REGISTRY_TOKEN=${DEPLOY_REGISTRY_TOKEN:-}
unset DEPLOY_REGISTRY_TOKEN

ROOT=${ROOT:-/home/anthony/www/crawlproof.com}
APP_DIR="$ROOT/app"
REPO=${REPO:-https://github.com/profullstack/crawlproof.com.git}
APP_PORT=${APP_PORT:-3100}
HEALTH_TIMEOUT=${HEALTH_TIMEOUT:-300}
STATE="$ROOT/.deploy-state"

log() { printf '\n===> %s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

compose() { (cd "$ROOT" && docker compose -f docker-compose.app.yml --env-file "$ROOT/deploy.env" "$@"); }

IMAGE_REPO=${IMAGE_REPO:-$(grep -E '^IMAGE_REPO=' "$ROOT/deploy.env" 2>/dev/null | tail -n1 | cut -d= -f2- || true)}
ROLLBACK_IMAGE=crawlproofcom-app:rollback

# Prebuilt mode: make <IMAGE_REPO>:<sha> present locally (reuse, else pull with the
# stdin token in a throwaway DOCKER_CONFIG so no credential is written to this box).
pull_image() {
  local ref=$1 cfg rc=1 i
  if docker image inspect "$ref" >/dev/null 2>&1; then log "Image $ref already on this box"; return 0; fi
  cfg=$(umask 077; mktemp -d "$ROOT/.docker-pull.XXXXXX")
  if [ -n "$REGISTRY_TOKEN" ]; then
    printf '%s' "$REGISTRY_TOKEN" | DOCKER_CONFIG=$cfg docker login "${IMAGE_REPO%%/*}" \
      -u github-actions --password-stdin >/dev/null 2>&1 \
      || log "Registry login with the stdin token failed; trying an anonymous pull"
  fi
  for i in 1 2 3; do
    log "Pulling $ref${REGISTRY_TOKEN:+ (authenticated)} (try $i)"
    if DOCKER_CONFIG=$cfg docker pull -q "$ref"; then rc=0; break; fi
    sleep $((i * 10))
  done
  rm -rf "$cfg"
  return $rc
}

# Prebuilt mode: keep only the running, the previous and the :rollback images.
prune_images() {
  local keep=" $SHA ${CURRENT:-} " tag
  for tag in $(docker images "$IMAGE_REPO" --format '{{.Tag}}' 2>/dev/null); do
    case $keep in *" $tag "*) continue ;; esac
    docker image rm "$IMAGE_REPO:$tag" >/dev/null 2>&1 || true
  done
}

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

# Secrets from logicsrc (same as the shared dev2 template): VAULT=<project>--<env>
# in deploy.env; every deploy overlays the vault onto app.env before building.
if [ -z "${VAULT:-}" ] && [ -f "$ROOT/deploy.env" ]; then
  eval "$(grep -E '^(VAULT|VAULT_TEAM|VAULT_SKIP)=' "$ROOT/deploy.env" || true)"
fi
sync_env_from_vault() {
  [ -n "${VAULT:-}" ] || return 0
  local bin team project env tmp
  bin=$(command -v logicsrc || echo "$HOME/.local/bin/logicsrc")
  [ -x "$bin" ] || { log "VAULT=$VAULT but no logicsrc CLI on this box: app.env unchanged"; return 0; }
  team=${VAULT_TEAM:-profullstack}
  project=${VAULT%--*}; env=${VAULT##*--}
  [ -n "$project" ] && [ "$project" != "$VAULT" ] || { log "VAULT must be <project>--<env>, got '$VAULT': app.env unchanged"; return 0; }
  local key="${LOGICSRC_API_KEY:-}"
  if [ -z "$key" ] && [ -r "$HOME/.config/logicsrc/deploy-api-key" ]; then key=$(cat "$HOME/.config/logicsrc/deploy-api-key"); fi
  tmp=$(umask 077; mktemp "$ROOT/.vault-env.XXXXXX")
  pull() { (cd "$ROOT" && "$@" "$bin" teams pull "$team" "$project" "$env" --env "$tmp" --format json >/dev/null 2>&1) && [ -s "$tmp" ]; }
  if { [ -n "$key" ] && pull env LOGICSRC_API_KEY="$key"; } || pull env -u LOGICSRC_API_KEY; then
    :
  else
    rm -f "$tmp"
    log "Could not pull vault $team/$VAULT: app.env unchanged"
    return 0
  fi
  [ -f "$ROOT/app.env" ] || : > "$ROOT/app.env"
  local merged
  merged=$(umask 077; mktemp "$ROOT/.app-env.XXXXXX")
  # awk: first file is the vault, second app.env. Rewrite app.env in place order,
  # then append the vault keys it did not have.
  awk -v changes="$merged.changes" -v skip=" ${VAULT_SKIP:-} " '
    function key(l) { sub(/^[ \t]*export[ \t]+/, "", l); return substr(l, 1, index(l, "=") - 1) }
    function val(l) { v = substr(l, index(l, "=") + 1); gsub(/^[ \t]+|[ \t]+$/, "", v); return v }
    NR == FNR {
      if ($0 ~ /^[ \t]*#/ || index($0, "=") == 0) next
      k = key($0); v = val($0)
      # A multi-line value (a PEM) pushed into the vault leaves continuation
      # lines that look like KEY=VALUE; docker rejects them, so drop any
      # "key" that is not a valid environment variable name.
      if (k !~ /^[A-Za-z_][A-Za-z0-9_]*$/) next
      if (index(skip, " " k " ")) next
      if (v == "" || v == "\"\"" || v == "\x27\x27") next
      vault[k] = $0; order[++n] = k; next
    }
    {
      if ($0 !~ /^[ \t]*#/ && index($0, "=") > 0 && key($0) ~ /^[A-Za-z_][A-Za-z0-9_]*$/) {
        k = key($0); seen[k] = 1
        if (k in vault) {
          if (vault[k] != $0) print "changed " k > changes
          print vault[k]; next
        }
      }
      print
    }
    END {
      for (i = 1; i <= n; i++) if (!(order[i] in seen)) { print vault[order[i]]; print "added " order[i] > changes }
    }
  ' "$tmp" "$ROOT/app.env" > "$merged"
  rm -f "$tmp"
  if [ -s "$merged.changes" ]; then
    (umask 077; cp "$ROOT/app.env" "$ROOT/app.env.prev"); chmod 600 "$ROOT/app.env.prev"
    chmod 600 "$merged"
    mv "$merged" "$ROOT/app.env"
    log "app.env from vault $VAULT: $(tr '\n' ' ' < "$merged.changes")"
  else
    rm -f "$merged"
    log "app.env already matches vault $VAULT"
  fi
  rm -f "$merged.changes"
}

sync_env_from_vault

UP_FLAGS=()
if [ -n "$IMAGE_REPO" ]; then
  # Prebuilt: pull CI's image for this exact commit. No build on this box, ever.
  [[ $SHA =~ ^[0-9a-f]{40}$ ]] || die "prebuilt mode needs a full commit id, got '$SHA'"
  export APP_IMAGE="$IMAGE_REPO:$SHA"
  UP_FLAGS=(--no-build)
  pull_image "$APP_IMAGE" || die "image $APP_IMAGE is not in the registry (CI has not pushed it, or the pull was refused); this box does not build. The running stack was not touched."
  log "Using prebuilt $APP_IMAGE"
  # Pin what is running now, so a failed health check goes back to it without a build.
  OLD_ID=$(docker inspect -f '{{.Image}}' crawlproof-app 2>/dev/null || true)
  [ -z "$OLD_ID" ] || docker tag "$OLD_ID" "$ROLLBACK_IMAGE"
else
  log "Building"
  compose build app
fi

log "Starting"
compose up -d "${UP_FLAGS[@]}"

if health; then
  log "Healthy"
  {
    echo "DEPLOYED_SHA=$SHA"
    echo "PREVIOUS_SHA=$CURRENT"
    echo "DEPLOYED_AT=$(date -u +%FT%TZ)"
    [ -z "${APP_IMAGE:-}" ] || echo "DEPLOYED_IMAGE=$APP_IMAGE"
  } > "$STATE"
  compose ps
  [ -z "$IMAGE_REPO" ] || prune_images
else
  log "UNHEALTHY after ${HEALTH_TIMEOUT}s — last 60 lines:"
  compose logs --tail 60 app || true
  if [ -n "$IMAGE_REPO" ] && [ -n "${OLD_ID:-}" ]; then
    log "Restoring the previous image ($CURRENT)"
    [ -z "$CURRENT" ] || git -C "$APP_DIR" checkout --detach "$CURRENT"
    APP_IMAGE=$ROLLBACK_IMAGE compose up -d --no-build
    health && log "Restored to $CURRENT" || log "ROLLBACK ALSO UNHEALTHY — site is down"
  elif [ -n "$CURRENT" ]; then
    log "Restoring $CURRENT"
    git -C "$APP_DIR" checkout --detach "$CURRENT"
    compose build app && compose up -d
    health && log "Restored to $CURRENT" || log "ROLLBACK ALSO UNHEALTHY — site is down"
  fi
  die "deploy of $SHA failed health check"
fi
