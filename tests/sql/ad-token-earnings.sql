-- Run with node scripts/test-ad-token-earnings.mjs (disposable PostgreSQL).
begin;
create role anon;
create role authenticated;
create role service_role;
create table ad_campaigns (id uuid primary key, owner_id uuid);
create table projects (id uuid primary key, owner_id uuid);
create table ad_slots (id uuid primary key, owner_id uuid, project_id uuid);
create table ad_impressions (campaign_id uuid, slot_id uuid, ts timestamptz, tier text, duplicate boolean);
create table ad_clicks (campaign_id uuid, slot_id uuid, ts timestamptz, tier text, valid boolean, charged_cents int, publisher_earn_cents int);
create table ad_stats_campaign_daily (campaign_id uuid, day date, paid_impressions bigint, free_impressions bigint, valid_clicks bigint, free_clicks bigint, spent_cents bigint);
create table ad_stats_slot_daily (slot_id uuid, day date, paid_impressions bigint, free_impressions bigint, valid_clicks bigint, free_clicks bigint, invalid_clicks bigint, earned_cents bigint);
insert into ad_campaigns values ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000010'), ('00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000020');
insert into projects values ('00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000010'), ('00000000-0000-0000-0000-000000000004','00000000-0000-0000-0000-000000000020');
insert into ad_slots values ('00000000-0000-0000-0000-000000000005','00000000-0000-0000-0000-000000000010','00000000-0000-0000-0000-000000000003'), ('00000000-0000-0000-0000-000000000006','00000000-0000-0000-0000-000000000020','00000000-0000-0000-0000-000000000004');
insert into ad_stats_campaign_daily values
 ('00000000-0000-0000-0000-000000000001', (now() at time zone 'UTC')::date-1,10,20,2,3,100),
 ('00000000-0000-0000-0000-000000000001', (now() at time zone 'UTC')::date-7,999,999,999,999,999),
 ('00000000-0000-0000-0000-000000000002', (now() at time zone 'UTC')::date-1,999,999,999,999,999);
insert into ad_stats_slot_daily values
 ('00000000-0000-0000-0000-000000000005', (now() at time zone 'UTC')::date-1,10,20,2,3,7,50),
 ('00000000-0000-0000-0000-000000000005', (now() at time zone 'UTC')::date-7,999,999,999,999,999,999),
 ('00000000-0000-0000-0000-000000000006', (now() at time zone 'UTC')::date-1,999,999,999,999,999,999);
insert into ad_impressions values
 ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000005',now(),'paid',false),
 ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000005',now(),'free',false),
 ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000005',now(),'free',true),
 ('00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000006',now(),'free',false);
insert into ad_clicks values
 ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000005',now(),'paid',true,25,10),
 ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000005',now(),'free',false,0,0),
 ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000005',now(),'paid',false,0,0),
 ('00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000006',now(),'paid',true,999,999);
-- APPLY MIGRATION HERE
set role service_role;
do $$
declare j jsonb; c jsonb; s jsonb;
begin
 j := public.ad_token_earnings('00000000-0000-0000-0000-000000000010',7);
 assert jsonb_array_length(j->'campaigns')=1, 'tenant scope leaked campaigns';
 assert jsonb_array_length(j->'slots')=1, 'tenant scope leaked slots';
 c := j->'campaigns'->0; s := j->'slots'->0;
 assert (c->>'impressions')::int=11 and (c->>'free_impressions')::int=21, 'wrong window/duplicate impressions';
 assert (c->>'clicks')::int=3 and (c->>'free_clicks')::int=4, 'billed/free classification';
 assert (c->>'spent_cents')::int=125, 'wrong windowed spend';
 assert (s->>'invalid_clicks')::int=8, 'rejected/free classification';
 assert (s->>'earned_cents')::int=60, 'wrong windowed earnings';
 assert jsonb_array_length(j->'daily')=2, 'daily boundary mismatch';
 assert (select sum((d->>'spentCents')::int) from jsonb_array_elements(j->'daily') d)=125, 'daily spend mismatch';
 j := public.ad_token_earnings('00000000-0000-0000-0000-000000000030',7);
 assert j->'campaigns'='[]'::jsonb and j->'slots'='[]'::jsonb, 'empty owner leaked data';
 begin
   perform public.ad_token_earnings(null,7);
   raise exception 'null owner accepted';
 exception when invalid_parameter_value then null; end;
 begin
   perform public.ad_token_earnings('00000000-0000-0000-0000-000000000010',999999);
   raise exception 'unbounded window accepted';
 exception when invalid_parameter_value then null; end;
end $$;
reset role;
set role authenticated;
do $$ begin
 begin
  perform public.ad_token_earnings('00000000-0000-0000-0000-000000000010',7);
  raise exception 'authenticated user can choose another owner';
 exception when insufficient_privilege then null; end;
end $$;
reset role;
set role anon;
do $$ begin
 begin
  perform public.ad_token_earnings('00000000-0000-0000-0000-000000000010',7);
  raise exception 'anonymous user can read earnings';
 exception when insufficient_privilege then null; end;
end $$;
reset role;
rollback;
