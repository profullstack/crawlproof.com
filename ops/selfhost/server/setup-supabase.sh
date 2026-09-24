#!/usr/bin/env bash
#
# Stand up self-hosted Supabase for crawlproof.com on dev2.
# Run as root ON THE APP SERVER. Idempotent: a second run keeps the generated
# secrets, certificate and data, and only rewrites the crawlproof overlay
# (tuning, pg_hba, compose override) before restarting the stack.
#
# Adapted from profullstack/niche-db ops/selfhost-supabase. Two deliberate
# differences, both because crawlproof is a Supabase *application* and nichedb
# was only ever a Postgres box:
#
#   1. No lock_down_public. crawlproof talks to PostgREST with the anon and
#      authenticated roles and guards its rows with RLS, so revoking those
#      grants would take the whole app offline.
#   2. No Caddy. dev2 already terminates TLS with nginx + certbot for every
#      other vhost, so the gateway is published on loopback and nginx proxies
#      to it. Running Caddy here would fight nginx for :80 and :443.
#
# What it does:
#   1. System: base packages, Docker log rotation, ufw (ssh + 80/443 + Postgres)
#   2. Supabase: official setup.sh at a pinned self-hosted release tag
#   3. .env: public URLs, SMTP, compose overrides
#   4. Postgres: self-signed TLS cert, pg_hba that only lets `postgres` in from
#      outside and only over TLS, tuning sized from this box's RAM and CPUs
#   5. Start the stack and create the extensions crawlproof's schema needs
#   6. Write crawlproof-connection.env (0600) with the app's keys
#
# Knobs (environment variables):
#   SUPABASE_REF   self-hosted/v0.8.2   pinned release of supabase/docker
#   INSTALL_ROOT   /home/anthony/www/crawlproof.com
#   PROJECT        supabase             project directory name
#   DB_DOMAIN      db.crawlproof.com    Postgres host name (cert SAN)
#   STUDIO_DOMAIN  supabase.crawlproof.com
#   SITE_URL       https://crawlproof.com
#   DB_PORT        5432                 public Postgres port on the host
#   KONG_HTTP_PORT 8000                 published on loopback only
#   SMTP_*                              GoTrue outbound mail (Resend)
#   SKIP_SYSTEM    0                    1 = no apt/ufw/docker
#
set -euo pipefail

SUPABASE_REF=${SUPABASE_REF:-self-hosted/v0.8.2}
INSTALL_ROOT=${INSTALL_ROOT:-/home/anthony/www/crawlproof.com}
PROJECT=${PROJECT:-supabase}
DB_DOMAIN=${DB_DOMAIN:-db.crawlproof.com}
STUDIO_DOMAIN=${STUDIO_DOMAIN:-supabase.crawlproof.com}
SITE_URL=${SITE_URL:-https://crawlproof.com}
DB_PORT=${DB_PORT:-5432}
KONG_HTTP_PORT=${KONG_HTTP_PORT:-8000}
SMTP_HOST=${SMTP_HOST:-smtp.resend.com}
SMTP_PORT=${SMTP_PORT:-465}
SMTP_USER=${SMTP_USER:-resend}
SMTP_PASS=${SMTP_PASS:-}
SMTP_SENDER_NAME=${SMTP_SENDER_NAME:-CrawlProof}
SMTP_ADMIN_EMAIL=${SMTP_ADMIN_EMAIL:-support@crawlproof.com}
# Fixed subnet for the compose network, so pg_hba can tell the gateway (where
# Docker's userland proxy makes outside clients appear) from real services.
DOCKER_SUBNET=${DOCKER_SUBNET:-172.31.251.0/24}
DOCKER_GATEWAY=${DOCKER_GATEWAY:-172.31.251.1}
SKIP_SYSTEM=${SKIP_SYSTEM:-0}

DIR="$INSTALL_ROOT/$PROJECT"
PG_UID=100 # postgres inside supabase/postgres:17.6.1.x
PG_GID=101

log() { printf '\n===> %s\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

[ "$SKIP_SYSTEM" = 1 ] || [ "$(id -u)" = 0 ] || die "run as root (or SKIP_SYSTEM=1 for a rehearsal)"

backup() { # never overwrite without a numbered copy beside the original
  local f=$1 n=1 dir name base ext
  [ -e "$f" ] || return 0
  dir=$(dirname "$f")
  name=$(basename "$f")
  if [[ "${name#.}" == *.* ]]; then base=${name%.*} ext=".${name##*.}"; else base=$name ext=""; fi
  while [ -e "$dir/$base.bak-$(printf %03d $n)$ext" ]; do n=$((n + 1)); done
  cp -a "$f" "$dir/$base.bak-$(printf %03d $n)$ext"
}

ssh_ports() {
  ss -ltnpH 2>/dev/null | awk '/"sshd"/ {n=split($4,a,":"); print a[n]}' | sort -u
}

# ---------------------------------------------------------------- 1. system
system_setup() {
  log "Base packages"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -qq -y curl ca-certificates openssl jq ufw >/dev/null

  log "Docker log rotation"
  mkdir -p /etc/docker
  if [ ! -s /etc/docker/daemon.json ]; then
    printf '{\n  "log-driver": "json-file",\n  "log-opts": { "max-size": "50m", "max-file": "3" }\n}\n' > /etc/docker/daemon.json
    systemctl reload docker 2>/dev/null || true
  elif ! grep -q max-size /etc/docker/daemon.json; then
    warn "/etc/docker/daemon.json exists without log rotation; left untouched"
  fi

  log "Firewall"
  local p ports
  ports=$(ssh_ports)
  [ -n "$ports" ] || ports=22
  for p in $ports; do ufw allow "$p/tcp" >/dev/null; done
  ufw allow "$DB_PORT/tcp" >/dev/null
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
  ufw --force enable >/dev/null
  # Docker publishes ports through its own iptables chains, ahead of ufw, so
  # the rules above document intent; the real gate for 5432 is pg_hba + TLS.
  ufw status | sed 's/^/    /'
}

# ------------------------------------------------------------- 2. supabase
supabase_setup() {
  mkdir -p "$INSTALL_ROOT"
  if [ -f "$DIR/.env" ] && [ -f "$DIR/docker-compose.yml" ]; then
    log "Supabase project already at $DIR; keeping its secrets"
    return
  fi
  log "Supabase $SUPABASE_REF into $DIR"
  local tmp
  tmp=$(mktemp -d)
  curl -fsSL "https://raw.githubusercontent.com/supabase/supabase/$SUPABASE_REF/docker/setup.sh" -o "$tmp/setup.sh"
  local flags=(--ref "$SUPABASE_REF" -p "$PROJECT" -y)
  [ "$SKIP_SYSTEM" = 1 ] && flags+=(--skip-deps)
  # setup.sh prints every generated secret; keep that off the terminal (and
  # out of whatever ssh session is watching) in a root-only log instead.
  local slog="$INSTALL_ROOT/$PROJECT-setup.log"
  (umask 077 && : > "$slog")
  if ! (cd "$INSTALL_ROOT" && bash "$tmp/setup.sh" "${flags[@]}") >> "$slog" 2>&1; then
    grep -E '^(===>|ERROR|WARNING)' "$slog" | tail -n 20 >&2
    die "Supabase setup.sh failed; full log (contains secrets): $slog"
  fi
  grep -E '^===>' "$slog" | grep -v -i 'key\|secret' | sed 's/^/    /' || true
  rm -rf "$tmp"
}

set_env() { # set_env KEY VALUE  -> replace or append in $DIR/.env
  local k=$1 v=$2
  if grep -q "^$k=" "$DIR/.env"; then
    # Rewrite with awk, not sed: these values carry /, |, & and + freely and
    # every sed delimiter would eventually collide with one of them.
    awk -v k="$k" -v v="$v" 'BEGIN{FS="="} $1==k {print k "=" v; next} {print}' "$DIR/.env" > "$DIR/.env.tmp"
    mv "$DIR/.env.tmp" "$DIR/.env"
  else
    printf '%s=%s\n' "$k" "$v" >> "$DIR/.env"
  fi
}
get_env() { grep "^$1=" "$DIR/.env" | head -n1 | cut -d= -f2-; }

configure_env() {
  log "Configuring .env"
  backup "$DIR/.env"
  set_env SUPABASE_PUBLIC_URL "https://$STUDIO_DOMAIN"
  set_env API_EXTERNAL_URL "https://$STUDIO_DOMAIN"
  set_env SITE_URL "$SITE_URL"
  set_env ADDITIONAL_REDIRECT_URLS "${SITE_URL}/**,https://www.crawlproof.com/**"
  set_env POOLER_TENANT_ID crawlproof
  set_env STUDIO_DEFAULT_ORGANIZATION "Profullstack"
  set_env STUDIO_DEFAULT_PROJECT "crawlproof"
  set_env API_GW_HTTP_PORT "$KONG_HTTP_PORT"
  set_env KONG_HTTP_PORT "$KONG_HTTP_PORT"
  # crawlproof signs its own users up through GoTrue; keep signup on and keep
  # confirmation required (the cloud project confirmed 94 of 113).
  set_env DISABLE_SIGNUP false
  set_env ENABLE_ANONYMOUS_USERS false
  set_env ENABLE_EMAIL_SIGNUP true
  set_env ENABLE_EMAIL_AUTOCONFIRM false
  if [ -n "$SMTP_PASS" ]; then
    set_env SMTP_HOST "$SMTP_HOST"
    set_env SMTP_PORT "$SMTP_PORT"
    set_env SMTP_USER "$SMTP_USER"
    set_env SMTP_PASS "$SMTP_PASS"
    set_env SMTP_SENDER_NAME "$SMTP_SENDER_NAME"
    set_env SMTP_ADMIN_EMAIL "$SMTP_ADMIN_EMAIL"
  else
    warn "SMTP_PASS not set; GoTrue cannot send magic links until it is"
  fi
  set_env COMPOSE_FILE "docker-compose.yml:docker-compose.crawlproof.yml"
  chmod 600 "$DIR/.env"
}

# --------------------------------------------------------------- 4. postgres
detect_resources() {
  MEM_MB=${MEM_MB:-$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)}
  CPUS=${CPUS:-$(nproc)}
}

write_tls() {
  local tls="$DIR/volumes/crawlproof/tls"
  mkdir -p "$tls"
  if [ ! -s "$tls/server.key" ]; then
    log "Self-signed TLS certificate for $DB_DOMAIN (10 years)"
    openssl req -x509 -nodes -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 \
      -days 3650 -subj "/CN=$DB_DOMAIN" -addext "subjectAltName=DNS:$DB_DOMAIN" \
      -keyout "$tls/server.key" -out "$tls/server.crt" 2>/dev/null
  fi
  chmod 600 "$tls/server.key"
  chmod 644 "$tls/server.crt"
  chown "$PG_UID:$PG_GID" "$tls/server.key" "$tls/server.crt"
}

write_pg_hba() {
  cat > "$DIR/volumes/crawlproof/pg_hba.conf" <<EOF
# crawlproof: managed by ops/selfhost/server/setup-supabase.sh
# Inside the container.
local   all  supabase_admin                          trust
local   all  all                                     peer map=supabase_map
host    all  all            127.0.0.1/32             trust
host    all  all            ::1/128                  trust
# The compose network's gateway is where outside clients show up whenever
# Docker proxies a published port (localhost, IPv6). Treat it as the internet.
hostssl all  postgres       ${DOCKER_GATEWAY}/32     scram-sha-256
host    all  all            ${DOCKER_GATEWAY}/32     reject
# The Supabase services on the compose network.
host    all  all            ${DOCKER_SUBNET}         scram-sha-256
# The internet: only the app's role, only over TLS.
hostssl all  postgres       0.0.0.0/0                scram-sha-256
hostssl all  postgres       ::/0                     scram-sha-256
host    all  all            0.0.0.0/0                reject
host    all  all            ::/0                     reject
EOF
}

write_tuning() {
  detect_resources
  local sb=$((MEM_MB / 4)) ecs=$((MEM_MB * 7 / 10))
  local mwm=$((MEM_MB / 16)); [ $mwm -gt 2048 ] && mwm=2048
  local half=$((CPUS / 2)); [ $half -lt 1 ] && half=1; [ $half -gt 4 ] && half=4
  log "Postgres tuning for ${MEM_MB} MB RAM, ${CPUS} CPUs"
  cat > "$DIR/volumes/crawlproof/crawlproof.conf" <<EOF
# crawlproof: managed by ops/selfhost/server/setup-supabase.sh
# Sized for ${MEM_MB} MB RAM / ${CPUS} CPUs. Loaded last from conf.d, so it wins.
hba_file = '/etc/crawlproof/pg_hba.conf'
ssl = on
ssl_cert_file = '/etc/crawlproof/tls/server.crt'
ssl_key_file = '/etc/crawlproof/tls/server.key'

max_connections = 300
shared_buffers = ${sb}MB
effective_cache_size = ${ecs}MB
maintenance_work_mem = ${mwm}MB
work_mem = 32MB
wal_buffers = 64MB
max_wal_size = 8GB
min_wal_size = 1GB
checkpoint_timeout = 15min
checkpoint_completion_target = 0.9
random_page_cost = 1.1
effective_io_concurrency = 200

max_worker_processes = $((CPUS + 8))
max_parallel_workers = ${CPUS}
max_parallel_workers_per_gather = ${half}
max_parallel_maintenance_workers = ${half}

max_replication_slots = 10
max_logical_replication_workers = 8

# The tracker writes constantly and the ad tables are rolled up every 10 min.
autovacuum_max_workers = 4
autovacuum_vacuum_scale_factor = 0.05
autovacuum_analyze_scale_factor = 0.02
autovacuum_vacuum_cost_limit = 2000

# pg_cron runs the 10 crawlproof jobs; it must load in the postmaster.
cron.database_name = 'postgres'
EOF
}

# Postgres runs as uid 100 inside the container. $INSTALL_ROOT lives under
# /home/anthony/www, which is setgid anthony, so everything created here
# inherits group anthony at 0750 and uid 100 cannot even traverse the
# directory — which postgres reports only as "postgresql.conf contains
# errors", with no hint that hba_file was simply unreadable.
fix_perms() {
  local d="$DIR/volumes/crawlproof"
  chmod 755 "$d" "$d/tls"
  [ -f "$d/pg_hba.conf" ] && chmod 644 "$d/pg_hba.conf"
  [ -f "$d/crawlproof.conf" ] && chmod 644 "$d/crawlproof.conf"
  chmod 644 "$d/tls/server.crt"
  chmod 600 "$d/tls/server.key"
  chown "$PG_UID:$PG_GID" "$d/tls/server.key" "$d/tls/server.crt"
}

write_overlay() {
  detect_resources
  local shm=$((MEM_MB / 8)); [ $shm -lt 256 ] && shm=256
  [ $shm -gt 4096 ] && shm=4096
  {
    echo "# crawlproof: managed by ops/selfhost/server/setup-supabase.sh"
    echo "services:"
    echo "  db:"
    echo "    shm_size: ${shm}m"
    echo "    ports:"
    echo "      - \"${DB_PORT}:5432\""
    echo "    volumes:"
    echo "      - ./volumes/crawlproof/crawlproof.conf:/etc/postgresql-custom/conf.d/zz-crawlproof.conf:ro,z"
    echo "      - ./volumes/crawlproof/pg_hba.conf:/etc/crawlproof/pg_hba.conf:ro,z"
    echo "      - ./volumes/crawlproof/tls:/etc/crawlproof/tls:ro,z"
    # The gateway is Envoy and the service is called api-gw as of
    # self-hosted/v0.8.x; `kong` survives only as a network alias, so naming a
    # `kong` service here invents an imageless one and the project won't load.
    echo "  api-gw:"
    echo "    # nginx on the host terminates TLS and proxies here."
    echo "    ports: !override"
    echo "      - \"127.0.0.1:\${API_GW_HTTP_PORT}:8000/tcp\""
    echo "  supavisor:"
    echo "    # The db itself owns the public ${DB_PORT}; the pooler stays on loopback."
    echo "    ports: !override"
    echo "      - \"127.0.0.1:\${POOLER_PROXY_PORT_TRANSACTION}:6543\""
    echo "networks:"
    echo "  default:"
    echo "    ipam:"
    echo "      config:"
    echo "        - subnet: ${DOCKER_SUBNET}"
    echo "          gateway: ${DOCKER_GATEWAY}"
  } > "$DIR/docker-compose.crawlproof.yml"
}

# ------------------------------------------------------------------ 5. start
compose() { (cd "$DIR" && docker compose "$@"); }

start_stack() {
  log "Starting the stack"
  compose up -d --wait || compose up -d
  # A config change on an already-running db needs a restart to take effect.
  compose restart db >/dev/null

  local i
  for i in $(seq 1 90); do
    docker exec supabase-db pg_isready -U postgres -h localhost >/dev/null 2>&1 && break
    sleep 2
  done
}

sql_admin() { docker exec -i supabase-db psql -U supabase_admin -h localhost -d postgres -v ON_ERROR_STOP=1 -X -q -At "$@"; }

# Four things self-hosted/v0.8.2 leaves in a state the services cannot start
# from. All four were hit on a clean initdb of this release, and all four are
# idempotent, so this runs on every pass.
#
#   1. The service roles' passwords do not match POSTGRES_PASSWORD, so
#      PostgREST, GoTrue and Storage all crashloop on "password authentication
#      failed for user authenticator / supabase_auth_admin /
#      supabase_storage_admin".
#   2. auth.uid() and friends are created owned by supabase_admin, but GoTrue
#      migrates as supabase_auth_admin and does `create or replace`, which
#      fails with "must be owner of function uid".
#   3. graphql_public does not exist, and PostgREST is configured with
#      db-schemas=public,graphql_public, so it refuses to build a schema cache
#      and answers 403 to everything.
#   4. _realtime does not exist, and Realtime connects with
#      `SET search_path TO _realtime`, then dies with "no schema has been
#      selected to create in".
repair_bootstrap() {
  log "Repairing the bootstrap gaps in $SUPABASE_REF"
  local pw
  pw=$(get_env POSTGRES_PASSWORD)
  sql_admin <<EOF
do \$\$
declare r text;
begin
  foreach r in array array[
    'postgres','authenticator','supabase_auth_admin','supabase_storage_admin',
    'supabase_admin','supabase_replication_admin','supabase_read_only_user',
    'supabase_etl_admin','pgbouncer'
  ] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('alter role %I with password %L', r, '$pw');
    end if;
  end loop;
end \$\$;
EOF
  sql_admin <<'EOF'
create schema if not exists graphql_public;
create schema if not exists _realtime;
alter schema _realtime owner to supabase_admin;
grant all on schema _realtime to supabase_admin, postgres;
grant usage on schema graphql_public to anon, authenticated, service_role, authenticator;

do $$
declare r record;
begin
  execute 'alter schema auth owner to supabase_auth_admin';
  for r in select 'alter function '||p.oid::regprocedure||' owner to supabase_auth_admin' as cmd
           from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='auth'
  loop execute r.cmd; end loop;
  for r in select 'alter table auth.'||quote_ident(tablename)||' owner to supabase_auth_admin' as cmd
           from pg_tables where schemaname='auth'
  loop execute r.cmd; end loop;

  execute 'alter schema storage owner to supabase_storage_admin';
  for r in select 'alter function '||p.oid::regprocedure||' owner to supabase_storage_admin' as cmd
           from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='storage'
  loop execute r.cmd; end loop;
  for r in select 'alter table storage.'||quote_ident(tablename)||' owner to supabase_storage_admin' as cmd
           from pg_tables where schemaname='storage'
  loop execute r.cmd; end loop;

  -- PostgREST authenticates as authenticator and SET ROLEs per request;
  -- storage does the same for service_role.
  execute 'grant anon, authenticated, service_role to authenticator';
  execute 'grant anon, authenticated, service_role to postgres';
  execute 'grant service_role to supabase_storage_admin';
end $$;

grant usage on schema public to anon, authenticated, service_role;
grant usage on schema storage to anon, authenticated, service_role;
EOF
}

create_extensions() {
  # crawlproof's schema depends on all of these; pg_cron and pg_net drive the
  # 10 scheduled jobs that call back into the app.
  log "Extensions crawlproof needs"
  sql_admin <<'EOF'
create extension if not exists "uuid-ossp" with schema extensions;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_stat_statements with schema extensions;
create extension if not exists vector with schema public;
create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;
grant usage on schema cron to postgres;
grant all privileges on all tables in schema cron to postgres;
EOF
  sql_admin -c "select string_agg(extname,', ' order by extname) from pg_extension"
}

check_postgres() {
  log "Checks"
  sql_admin -c "select 'ssl='||current_setting('ssl')||' shared_buffers='||current_setting('shared_buffers')||' hba='||current_setting('hba_file')||' version='||current_setting('server_version')"
  # The opposite of nichedb: PostgREST must still be able to reach public.
  local anon
  anon=$(sql_admin -c "select has_schema_privilege('anon','public','usage')")
  [ "$anon" = t ] || die "anon lost USAGE on schema public — PostgREST would 401 every request"
  echo "anon can use schema public (correct for crawlproof)"
  df -h "$DIR/volumes/db/data" 2>/dev/null | tail -1 | awk '{print "data disk: "$4" free of "$2}'
}

write_connection() {
  local pw
  pw=$(get_env POSTGRES_PASSWORD)
  umask 077
  cat > "$DIR/crawlproof-connection.env" <<EOF
# crawlproof app connection (written by setup-supabase.sh). Keep secret.
# Mirrored into the vault as crawlproof--selfhost.
NEXT_PUBLIC_SUPABASE_URL=https://${STUDIO_DOMAIN}
NEXT_PUBLIC_SUPABASE_ANON_KEY=$(get_env ANON_KEY)
SUPABASE_SERVICE_ROLE_KEY=$(get_env SERVICE_ROLE_KEY)
SELFHOST_DATABASE_URL=postgres://postgres:${pw}@${DB_DOMAIN}:${DB_PORT}/postgres?sslmode=require
SELFHOST_DB_INTERNAL_URL=postgres://postgres:${pw}@127.0.0.1:${DB_PORT}/postgres
SELFHOST_DB_DOMAIN=${DB_DOMAIN}
SELFHOST_DB_PORT=${DB_PORT}
SELFHOST_STUDIO_URL=https://${STUDIO_DOMAIN}
SELFHOST_DASHBOARD_USERNAME=$(get_env DASHBOARD_USERNAME)
SELFHOST_DASHBOARD_PASSWORD=$(get_env DASHBOARD_PASSWORD)
SELFHOST_POSTGRES_PASSWORD=${pw}
SELFHOST_JWT_SECRET=$(get_env JWT_SECRET)
SELFHOST_SUPABASE_REF=${SUPABASE_REF}
EOF
  chmod 600 "$DIR/crawlproof-connection.env"
  log "Wrote $DIR/crawlproof-connection.env"
}

# ------------------------------------------------------------------- main
[ "$SKIP_SYSTEM" = 1 ] || system_setup
supabase_setup
mkdir -p "$DIR/volumes/crawlproof"
configure_env
write_tls
write_pg_hba
write_tuning
write_overlay
fix_perms
start_stack
create_extensions
check_postgres
write_connection
log "Done. Supabase for crawlproof is up in $DIR"
