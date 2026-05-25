-- Allow owners to delete their own queued/failed keywords so the
-- "Regenerate queue" action can clear the upcoming queue under RLS
-- (the route uses the user's anon-key session, not service-role).
-- The original migration only granted SELECT on lx_keyword to owners.
create policy "lx_keyword owner delete"
  on public.lx_keyword for delete
  using (
    exists (
      select 1 from public.lx_site s
      where s.id = site_id and s.user_id = auth.uid()
    )
  );
