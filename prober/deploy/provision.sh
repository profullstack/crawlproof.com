#!/usr/bin/env bash
# Idempotent provisioning for the CrawlProof port-drift prober droplet
# (docs/uptime-monitoring-prd.md §12). Run remotely by the deploy-prober GitHub
# Action on every deploy. Safe to re-run: performs first-time bootstrap of a
# bare droplet AND routine updates. No interactive login is ever required.
#
# Inputs (env):
#   REDIS_URL    - rediss://... broker URL (required)
#   DEPLOY_PATH  - repo checkout on the droplet (default /home/ubuntu/crawlproof.com)
set -euo pipefail

DEPLOY_PATH="${DEPLOY_PATH:-/home/ubuntu/crawlproof.com}"
ENV_FILE="/home/ubuntu/crawlproof-prober.env"
UNIT_SRC="${DEPLOY_PATH}/prober/deploy/crawlproof-prober.service"
UNIT_DST="/etc/systemd/system/crawlproof-prober.service"
export DEBIAN_FRONTEND=noninteractive

if [ -z "${REDIS_URL:-}" ]; then
  echo "[provision] ERROR: REDIS_URL is not set" >&2
  exit 1
fi

echo "[provision] system packages (nmap, build tools)"
sudo apt-get update -y
sudo apt-get install -y --no-install-recommends nmap curl ca-certificates build-essential

echo "[provision] Node 20"
if ! command -v node >/dev/null 2>&1 \
   || [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" != "20" ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

echo "[provision] Redis env file (0600)"
umask 077
printf 'REDIS_URL=%s\n' "${REDIS_URL}" > "${ENV_FILE}"
chmod 600 "${ENV_FILE}"

echo "[provision] build prober"
cd "${DEPLOY_PATH}/prober"
# Prefer a reproducible install, but never hard-fail the deploy if the lockfile
# is missing or out of sync with package.json — fall back to a plain install.
npm ci --no-audit --no-fund || npm install --no-audit --no-fund
npm run build

echo "[provision] install + (re)start systemd service"
sudo cp "${UNIT_SRC}" "${UNIT_DST}"
sudo systemctl daemon-reload
sudo systemctl enable crawlproof-prober
sudo systemctl restart crawlproof-prober
sudo systemctl --no-pager --lines=5 status crawlproof-prober || true
echo "[provision] done"
