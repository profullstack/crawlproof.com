-- Link a promo_post to the sp_post it enqueued for cookie-auth (browser)
-- platforms (reddit, instagram, mastodon, x, linkedin, facebook, threads).
--
-- Those platforms post asynchronously: postViaAccount only *queues* an sp_post
-- and returns before the Playwright worker actually publishes. Until now the
-- sweep marked the promo_post 'posted' at enqueue time with a null post_url —
-- so the "View post" link was missing and a post that later failed (dead
-- cookies / login wall) still read as posted. Storing the sp_post id lets the
-- worker reconcile the real outcome (URL, posted/failed, credit refund) back
-- onto the promo_post once the browser post settles.
alter table public.promo_post
  add column if not exists sp_post_id uuid references public.sp_post(id) on delete set null;

create index if not exists promo_post_sp_post_idx on public.promo_post(sp_post_id);
