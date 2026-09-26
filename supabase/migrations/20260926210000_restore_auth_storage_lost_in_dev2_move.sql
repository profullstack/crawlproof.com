-- Restore the trigger on auth.users and the RLS policies on storage.objects
-- that the 2026-09-25 move to the self-hosted Supabase stack on dev2 left
-- behind.
--
-- The move dumped DDL for the app schemas only, and pg_dump files a trigger
-- or policy under its table's schema, so on_auth_user_created (ON auth.users)
-- and both storage.objects policies were dropped while the public functions
-- and the buckets survived. Without the trigger, a signup gets no
-- public.profiles row, and everything keyed on profiles (projects, audits,
-- credit_purchases, organizations) fails its foreign key for that user.
-- Without the policies, owners cannot read their audit artifacts / PDF
-- reports through RLS and sp-images is not readable through the API.
--
-- Final state after replaying every migration in order:
--   0001_init.sql                               on_auth_user_created -> public.handle_new_user()
--   0005_credits.sql                            last redefinition of public.handle_new_user()
--   0002_storage.sql                            "artifact owner read"
--   20260528210000_sp_project_social_config.sql "sp-images public read"
-- Nothing later drops or renames any of these.
--
-- Idempotent: safe to re-run.

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

DROP POLICY IF EXISTS "artifact owner read" ON storage.objects;
CREATE POLICY "artifact owner read"
  ON storage.objects FOR SELECT
  USING (
    bucket_id IN ('audit-artifacts','pdf-reports')
    AND EXISTS (
      SELECT 1 FROM public.audits a
      WHERE a.id::text = split_part(name, '/', 1)
        AND a.owner_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "sp-images public read" ON storage.objects;
CREATE POLICY "sp-images public read"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'sp-images');

-- Backfill what handle_new_user would have written for users created while
-- the trigger was missing. This mirrors the function's INSERT exactly
-- (0005_credits.sql), including its literal credits_balance of 3.
-- profiles has no unique column besides id, so there is nothing to collide
-- on. The function sends no email and calls no webhook.
INSERT INTO public.profiles (id, email, display_name, credits_balance)
SELECT u.id, u.email, COALESCE(u.raw_user_meta_data->>'full_name', u.email), 3
FROM auth.users u
WHERE NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = u.id)
ON CONFLICT (id) DO NOTHING;
