#!/usr/bin/env bash
#
# Authorise the prober's key on dev2 for ONE thing: a port-forward to Redis.
#
# `restrict` turns everything off (no pty, no agent/X11 forwarding, no
# port-forwarding), then `port-forwarding` + `permitopen` turn exactly one
# destination back on. So this key cannot get a shell and cannot reach any
# other port on the box — it is strictly less access than the public port it
# replaces.
set -euo pipefail

# The prober's public key, from `cat ~/.ssh/id_ed25519_dev2.pub` on
# scan.crawlproof.com. Pass it as $1, or set PUBKEY.
PUBKEY=${1:-${PUBKEY:-}}
[ -n "$PUBKEY" ] || { echo "usage: authorize-prober-tunnel.sh '<ssh-ed25519 ... comment>'" >&2; exit 1; }
case "$PUBKEY" in
  ssh-*) ;;
  *) echo "that does not look like a public key" >&2; exit 1 ;;
esac
OPTS='restrict,port-forwarding,permitopen="127.0.0.1:6379",command="/bin/false"'
AK=/home/anthony/.ssh/authorized_keys

install -d -o anthony -g anthony -m 700 /home/anthony/.ssh
touch "$AK"; chown anthony:anthony "$AK"; chmod 600 "$AK"

# Drop any previous copy of this key so re-running does not stack entries.
# Match on the key material, not the comment, which anyone can change.
KEYBODY=$(printf '%s' "$PUBKEY" | awk '{print $2}')
grep -vF "$KEYBODY" "$AK" > "$AK.tmp" 2>/dev/null || true
mv "$AK.tmp" "$AK"
printf '%s %s\n' "$OPTS" "$PUBKEY" >> "$AK"
chown anthony:anthony "$AK"; chmod 600 "$AK"

echo "=== authorized_keys entries ==="
sed 's/AAAA[A-Za-z0-9+/=]*/<key>/' "$AK"
