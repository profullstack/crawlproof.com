-- Autoblog delivery moves onto the @profullstack/webhooks 0.2.1 hub.
--
-- The hub keeps endpoints and a durable delivery outbox (retries survive a
-- restart, delivery log, auto-disable after 20 failures in a row). Its tables
-- are the package's schemaSql('pg', 'hub_') shape, the same as ugig.net, read
-- and written by lib/webhooks/supabase-store.ts over supabase-js.
--
-- Endpoint owner = lx_site.id: an endpoint belongs to one autoblog site, and the
-- site's account manages it (/api/v1/webhooks?site=..., the dashboard, CLI, MCP).
--
-- Only the server (service role) touches these tables: RLS on, no policies,
-- and the claim RPC is granted to service_role alone.
--
-- Idempotent: safe to re-run.

create table if not exists public.hub_webhook_endpoints (
  id text primary key,
  owner text not null,
  url text not null,
  secret text not null,
  events text not null default '["*"]',
  description text not null default '',
  enabled integer not null default 1,
  failures integer not null default 0,
  disabled_reason text,
  created_at bigint not null,
  updated_at bigint not null
);
create index if not exists hub_webhook_endpoints_owner on public.hub_webhook_endpoints(owner);

create table if not exists public.hub_webhook_deliveries (
  id text primary key,
  endpoint_id text not null,
  owner text not null,
  event_id text not null,
  event_type text not null,
  payload text not null,
  status text not null default 'pending',
  attempts integer not null default 0,
  next_at bigint not null,
  last_status integer,
  last_error text,
  created_at bigint not null,
  updated_at bigint not null
);
create index if not exists hub_webhook_deliveries_due on public.hub_webhook_deliveries(status, next_at);
create index if not exists hub_webhook_deliveries_endpoint on public.hub_webhook_deliveries(endpoint_id, created_at);
create index if not exists hub_webhook_deliveries_owner on public.hub_webhook_deliveries(owner, created_at);

alter table public.hub_webhook_endpoints enable row level security;
alter table public.hub_webhook_deliveries enable row level security;
revoke all on public.hub_webhook_endpoints from anon, authenticated;
revoke all on public.hub_webhook_deliveries from anon, authenticated;
grant all on public.hub_webhook_endpoints to service_role;
grant all on public.hub_webhook_deliveries to service_role;

-- Take up to p_limit due deliveries and lease them until p_lease_until, so two
-- app processes never send the same row (the package's postgresStore claim,
-- as an RPC because PostgREST cannot express FOR UPDATE SKIP LOCKED).
create or replace function public.claim_hub_webhook_deliveries(p_now bigint, p_limit integer, p_lease_until bigint)
returns setof public.hub_webhook_deliveries
language sql
volatile
set search_path to 'public'
as $function$
  update public.hub_webhook_deliveries
     set next_at = p_lease_until
   where id in (
     select id from public.hub_webhook_deliveries
      where status = 'pending' and next_at <= p_now
      order by next_at
      limit p_limit
      for update skip locked
   )
  returning *;
$function$;
revoke execute on function public.claim_hub_webhook_deliveries(bigint, integer, bigint) from public, anon, authenticated;
grant execute on function public.claim_hub_webhook_deliveries(bigint, integer, bigint) to service_role;

-- The site's autoblog endpoint (the URL + secret on /autoblog/setup) in the hub.
alter table public.lx_site add column if not exists webhook_endpoint_id text;

-- Carry every configured site over: one endpoint per site, subscribed to the
-- autoblog event, with its secret's KEY BYTES unchanged.
--
-- The old sender (@profullstack/autoblog) used the whole secret string as the
-- HMAC key and as the bearer. The package uses a non-whsec_ string as its
-- UTF-8 bytes too, so those are copied as is (all 18 prod secrets on
-- 2026-10-28). A secret that itself starts with whsec_ would be base64-decoded
-- by the package, so it is stored as whsec_ + base64(the string): same key
-- bytes, and lib/webhooks/hub.ts bearerFor() turns it back into the string for
-- the Authorization header.
insert into public.hub_webhook_endpoints
  (id, owner, url, secret, events, description, enabled, failures, disabled_reason, created_at, updated_at)
select
  'wh_lx_' || replace(s.id::text, '-', ''),
  s.id::text,
  s.webhook_url,
  case
    when s.webhook_secret like 'whsec\_%'
      then 'whsec_' || replace(encode(convert_to(s.webhook_secret, 'UTF8'), 'base64'), E'\n', '')
    else s.webhook_secret
  end,
  '["com.crawlproof.post.published.v1"]',
  left('autoblog: ' || coalesce(s.domain, ''), 200),
  1,
  0,
  null,
  (extract(epoch from s.created_at) * 1000)::bigint,
  (extract(epoch from now()) * 1000)::bigint
from public.lx_site s
where coalesce(s.webhook_url, '') <> '' and coalesce(s.webhook_secret, '') <> ''
on conflict (id) do nothing;

update public.lx_site s
   set webhook_endpoint_id = 'wh_lx_' || replace(s.id::text, '-', '')
 where s.webhook_endpoint_id is null
   and exists (select 1 from public.hub_webhook_endpoints e where e.id = 'wh_lx_' || replace(s.id::text, '-', ''));
