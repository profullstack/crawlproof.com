-- Engine column on audits + multi-credit consume helper.
--
-- Engines:
--   'rule'   — local rule-based crawler, anonymous & free-quota path
--   'claude' — Claude Opus 4.7 + web tools (1 credit)
--   'openai' — OpenAI GPT-5 + web search (2 credits)

alter table public.audits
  add column if not exists engine text not null default 'rule'
  check (engine in ('rule', 'claude', 'openai'));

create index if not exists audits_engine_idx
  on public.audits(owner_id, engine, created_at desc);

-- Replace consume_credit so it accepts a count (atomic multi-credit decrement).
drop function if exists public.consume_credit(uuid);

create or replace function public.consume_credit(p_owner uuid, p_count int default 1)
returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_remaining int;
begin
  if p_count <= 0 then return true; end if;
  update public.profiles
  set credits_balance = credits_balance - p_count
  where id = p_owner and credits_balance >= p_count
  returning credits_balance into v_remaining;
  return v_remaining is not null;
end;
$$;

grant execute on function public.consume_credit(uuid, int) to authenticated, service_role;
