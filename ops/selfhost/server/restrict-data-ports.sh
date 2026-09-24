#!/usr/bin/env bash
#
# Restrict dev2's published Postgres port to an IP allowlist.
#
# The self-host kit publishes 5432 and guards it with pg_hba (TLS required,
# `postgres` role only, scram). That is decent, but it still means anyone on
# the internet can reach the port and try. Nothing outside our own
# infrastructure has any reason to connect.
#
# pg_hba is deliberately NOT changed: the nichedb session running in this same
# cluster depends on the `hostssl all postgres 0.0.0.0/0` rule, and postgres
# config stays theirs. This is purely a network-layer allowlist.
#
# DOCKER-USER, not ufw: Docker publishes ports by inserting its own iptables
# rules ahead of ufw's chains, so a ufw rule here would be decoration.
set -euo pipefail

PORT=${PORT:-5432}
# Our dev box, where the migration tooling and both agent sessions run.
ALLOW=${ALLOW:-67.205.189.229}

echo "=== before ==="
iptables -L DOCKER-USER -n --line-numbers | head -10

# Idempotent: strip any previous version of these rules first.
while iptables -D DOCKER-USER -p tcp --dport "$PORT" -j DROP 2>/dev/null; do :; done
for ip in $ALLOW 127.0.0.1 172.16.0.0/12; do
  while iptables -D DOCKER-USER -s "$ip" -p tcp --dport "$PORT" -j ACCEPT 2>/dev/null; do :; done
done

# Catch-all drop first, then insert the accepts above it (-I 1 prepends, so
# the last inserted ends up on top).
iptables -I DOCKER-USER 1 -p tcp --dport "$PORT" -j DROP
iptables -I DOCKER-USER 1 -s 172.16.0.0/12 -p tcp --dport "$PORT" -j ACCEPT
iptables -I DOCKER-USER 1 -s 127.0.0.1 -p tcp --dport "$PORT" -j ACCEPT
for ip in $ALLOW; do
  iptables -I DOCKER-USER 1 -s "$ip" -p tcp --dport "$PORT" -j ACCEPT
done

echo "=== after ==="
iptables -L DOCKER-USER -n --line-numbers | head -10

mkdir -p /etc/iptables
iptables-save > /etc/iptables/rules.v4
echo "persisted to /etc/iptables/rules.v4"

echo "=== postgres still up and pg_hba untouched ==="
docker exec supabase-db pg_isready -U postgres -h localhost
grep -c 'hostssl all  postgres       0.0.0.0/0' \
  /home/anthony/www/crawlproof.com/supabase/volumes/crawlproof/pg_hba.conf \
  && echo "nichedb's hba rule intact"
