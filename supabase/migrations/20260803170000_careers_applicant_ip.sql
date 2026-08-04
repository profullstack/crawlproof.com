-- Spam control for the public application form.
--
-- /api/careers/apply is an unauthenticated POST on the open internet. The
-- (job_id, email) unique constraint stops an honest double-submit but does
-- nothing against a script that varies the address, so we need a per-source
-- counter. Storing a salted hash rather than the address itself keeps the
-- rate limit workable without turning the applications table into a log of
-- who visited from where.
alter table public.job_applications
  add column if not exists ip_hash text;

-- The rate-limit query is "how many applications from this source recently",
-- so the index leads on ip_hash and orders by time.
create index if not exists job_applications_ip_recent_idx
  on public.job_applications(ip_hash, created_at desc);
