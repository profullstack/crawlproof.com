#!/usr/bin/env bash
# Re-enable the scheduled jobs on the self-hosted database at cutover.
#
# They are loaded parked (see load-selfhost.sh / park-cron): while DNS still
# pointed at Railway, an active job here would have driven a second copy of
# every scheduled action against the live app. Run this only once
# crawlproof.com resolves to dev2 AND the cloud project's jobs are gone,
# otherwise both databases drive the same app.
set -euo pipefail

SITE=${SITE:-https://crawlproof.com}

resolved=$(getent hosts crawlproof.com | awk '{print $1}' | head -1)
echo "crawlproof.com resolves to ${resolved:-<nothing>}"
if [ "$resolved" != "23.95.228.174" ]; then
  echo "REFUSING: crawlproof.com does not resolve to dev2 yet — unparking now" >&2
  echo "would point every job at whatever is still serving that name." >&2
  exit 1
fi

docker exec -i supabase-db psql -U postgres -h localhost -d postgres -v ON_ERROR_STOP=1 -X <<EOF
update public.cron_config set value = '$SITE' where key = 'site_url';
update cron.job set active = true where not active;
select jobid, jobname, schedule, active from cron.job order by jobid;
EOF
