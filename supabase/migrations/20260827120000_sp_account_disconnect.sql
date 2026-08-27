-- Disconnecting a social account never worked for a well-used account.
-- The row simply stayed connected, and the UI gave no reason.
--
-- Deleting an sp_account cascades into sp_post, promo_post and promo_job,
-- and deleting *those* fires a second hop of referential actions. Almost
-- none of the FK columns involved were indexed:
--
--   sp_account -> sp_post.account_id        (cascade)  only a partial
--                                                      index on
--                                                      status='queued',
--                                                      which a cascade
--                                                      can't use
--   sp_account -> promo_post.account_id     (cascade)  no index
--   sp_account -> promo_job.account_id      (cascade)  no index
--   sp_post    -> sp_post.thread_root_id    (set null) no index  <-- worst
--   promo_post -> promo_job.promo_post_id   (set null) no index
--   promo_job  -> promo_job.parent_job_id   (set null) no index
--
-- thread_root_id was the one that made it hopeless: sp_post is 479 MB, so
-- every one of the ~850 posts being deleted triggered its own full scan of
-- it. The delete was always killed by the 8s statement timeout PostgREST
-- gives `authenticated`, and disconnectAccount's caller discarded the
-- error. With these indexes the same delete takes 333 ms.
--
-- Worth knowing if this ever regresses: raising the timeout is not an
-- option from inside the database. `SET LOCAL statement_timeout` in a
-- function, and `ALTER FUNCTION ... SET statement_timeout`, both leave
-- the running statement's timer alone — it is armed before the function
-- is entered. Indexing the FK columns is the fix, not a longer clock.

-- ---- first hop: the cascade out of sp_account ----
create index if not exists sp_post_account_id_idx
  on public.sp_post(account_id);

create index if not exists promo_post_account_id_idx
  on public.promo_post(account_id);

create index if not exists promo_job_account_id_idx
  on public.promo_job(account_id);

-- ---- second hop: the set-nulls fired by deleting those rows ----
-- Partial, because a referential `= $1` lookup never matches a null and
-- these columns are null on nearly every row.
create index if not exists sp_post_thread_root_id_idx
  on public.sp_post(thread_root_id) where thread_root_id is not null;

create index if not exists promo_job_promo_post_id_idx
  on public.promo_job(promo_post_id) where promo_post_id is not null;

create index if not exists promo_job_parent_job_id_idx
  on public.promo_job(parent_job_id) where parent_job_id is not null;
