-- Enable Supabase Realtime for the Promote tables so the UI updates via push
-- (worker posts appear live) instead of client polling. RLS stays enforced for
-- realtime, so each subscriber only receives changes to their own rows:
--   promo_list "owner all"  (auth.uid() = user_id)
--   promo_post "via owned list" (list belongs to auth.uid())
-- `add table` has no IF NOT EXISTS, so guard each so the migration is re-runnable.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'promo_post'
  ) then
    alter publication supabase_realtime add table public.promo_post;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'promo_list'
  ) then
    alter publication supabase_realtime add table public.promo_list;
  end if;
end $$;
