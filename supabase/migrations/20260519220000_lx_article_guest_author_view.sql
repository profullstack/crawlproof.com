-- Author-side visibility for guest posts.
--
-- Convention: a guest-post row carries site_id = target (where the
-- post will be published, drives slug uniqueness + webhook delivery).
-- The existing "lx_article via owned site" SELECT policy lets the
-- target's owner see those rows.
--
-- The AUTHOR also needs to see their own outgoing guest posts (for
-- audit, retry, dashboard counts) — they own the credit that was
-- burned. Add a parallel SELECT policy keyed on author_site_id.
create policy "lx_article via owned author"
  on public.lx_article for select
  using (
    is_guest_post = true
    and exists (
      select 1 from public.lx_site s
      where s.id = author_site_id and s.user_id = auth.uid()
    )
  );
