#!/usr/bin/env bash
#
# Give the prober a private path to dev2's Redis, so Redis needs no public
# port at all.
#
# The prober is the only remote consumer of that queue. It stays on its own
# droplet on purpose: it runs nmap against customer sites, and doing that from
# the box that serves crawlproof.com would put the app's own IP behind the
# scanning traffic.
set -euo pipefail

sudo tee /etc/systemd/system/redis-tunnel.service >/dev/null <<'EOF'
[Unit]
Description=SSH tunnel to dev2 Redis (BullMQ prober queue)
After=network-online.target
Wants=network-online.target

[Service]
User=ubuntu
# -N: no remote command (the key is restricted to /bin/false anyway)
# ExitOnForwardFailure: fail loudly instead of running a tunnel-less process
#   that would let the prober "start" and silently never see a job.
ExecStart=/usr/bin/ssh -NT \
  -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 \
  -o StrictHostKeyChecking=accept-new \
  -o BatchMode=yes \
  -i /home/ubuntu/.ssh/id_ed25519_dev2 \
  -L 127.0.0.1:6379:127.0.0.1:6379 \
  anthony@dev2.profullstack.com
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now redis-tunnel.service
sleep 5
systemctl is-active redis-tunnel.service
echo "--- tunnel listening? ---"
ss -tlnp 2>/dev/null | grep 6379 || echo "NOT LISTENING"
