#!/usr/bin/env bash
#
# Prepare the host side of the app deploy: directory ownership, the Redis data
# directory, and the ssh key GitHub Actions uses. Run as root on dev2, once.
#
# The ownership split is the point of this script. `anthony` deploys, so it
# owns the app files and app.env; `supabase/` stays root-owned because it holds
# the database's God Mode keys and a deploy has no business reading them.
set -euo pipefail

ROOT=${ROOT:-/home/anthony/www/crawlproof.com}
USER_NAME=${USER_NAME:-anthony}

log() { printf '\n===> %s\n' "$*"; }

log "App files to $USER_NAME, supabase/ to root"
install -d -o "$USER_NAME" -g "$USER_NAME" -m 2750 "$ROOT"
for f in app.env deploy.env docker-compose.app.yml deploy-app.sh; do
  [ -e "$ROOT/$f" ] && chown "$USER_NAME:$USER_NAME" "$ROOT/$f"
done
[ -e "$ROOT/app.env" ] && chmod 600 "$ROOT/app.env"
[ -e "$ROOT/deploy.env" ] && chmod 600 "$ROOT/deploy.env"
[ -e "$ROOT/deploy-app.sh" ] && chmod 755 "$ROOT/deploy-app.sh"
[ -d "$ROOT/app" ] && chown -R "$USER_NAME:$USER_NAME" "$ROOT/app"
[ -d "$ROOT/supabase" ] && { chown root:root "$ROOT/supabase"; chmod 2750 "$ROOT/supabase"; }

# redis:7-alpine's entrypoint drops to uid 999 before exec'ing redis-server, so
# a bind-mounted data directory owned by the deploy user is unwritable. Redis
# starts anyway and only fails later, at the first BGSAVE, after which it
# refuses EVERY write with "MISCONF Redis is configured to save RDB snapshots,
# but it's currently unable to persist to disk" — which surfaces in the app as
# failing BullMQ commands, not as a Redis permissions error.
log "Redis data directory to uid 999 (redis)"
install -d -m 750 "$ROOT/volumes/redis"
chown -R 999:1000 "$ROOT/volumes/redis"
ls -ldn "$ROOT/volumes/redis"

log "Deploy key for GitHub Actions"
KEY=/home/$USER_NAME/.ssh/id_ed25519_deploy
install -d -o "$USER_NAME" -g "$USER_NAME" -m 700 "/home/$USER_NAME/.ssh"
if [ ! -f "$KEY" ]; then
  sudo -u "$USER_NAME" ssh-keygen -t ed25519 -N '' -C "github-actions-deploy@crawlproof" -f "$KEY"
fi
touch "/home/$USER_NAME/.ssh/authorized_keys"
chown "$USER_NAME:$USER_NAME" "/home/$USER_NAME/.ssh/authorized_keys"
chmod 600 "/home/$USER_NAME/.ssh/authorized_keys"
grep -qF "$(cat "$KEY.pub")" "/home/$USER_NAME/.ssh/authorized_keys" \
  || cat "$KEY.pub" >> "/home/$USER_NAME/.ssh/authorized_keys"

log "Checks"
sudo -u "$USER_NAME" bash -c "docker ps >/dev/null 2>&1 && echo 'docker: ok' || echo 'docker: DENIED'"
sudo -u "$USER_NAME" bash -c "head -c1 $ROOT/app.env >/dev/null 2>&1 && echo 'app.env: readable' || echo 'app.env: DENIED'"
sudo -u "$USER_NAME" bash -c "head -c1 $ROOT/supabase/.env >/dev/null 2>&1 && echo 'supabase/.env: READABLE (WRONG)' || echo 'supabase/.env: correctly denied'"

cat <<EOF

Put these in the repo's GitHub secrets:
  DEV2_SSH_KEY      <- $KEY  (the private half)
  DEV2_KNOWN_HOSTS  <- ssh-keyscan dev2.profullstack.com
  DEV2_HOST         <- dev2.profullstack.com
  DEV2_USER         <- $USER_NAME
EOF
