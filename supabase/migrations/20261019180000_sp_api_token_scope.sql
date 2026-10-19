-- Read-only API tokens.
--
-- A token used to be all-or-nothing: whatever it was minted for, it could
-- post to socials, spend ad budget and run the MCP tools. CoinPay's business
-- report needs to read a merchant's site stats and nothing else, so a token
-- can now carry a scope. NULL keeps the old full-access meaning for every
-- existing token; 'stats:read' is accepted only by the tracker read routes
-- (/api/tracker/v1/sites, /stats, /report) and refused everywhere else.
--
-- Apply by hand, one file: ssh root@dev2 docker exec -i supabase-db psql -U postgres -d postgres -1

alter table public.sp_api_token
  add column if not exists scope text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.sp_api_token'::regclass and conname = 'sp_api_token_scope_check'
  ) then
    alter table public.sp_api_token
      add constraint sp_api_token_scope_check check (scope is null or scope in ('stats:read'));
  end if;
end $$;

comment on column public.sp_api_token.scope is
  'NULL = full access (legacy). stats:read = only the tracker read routes; every other bearer route refuses it.';
