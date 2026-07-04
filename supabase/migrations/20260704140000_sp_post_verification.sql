-- Verification-code (identity challenge) support for browser-automated posts.
--
-- Platforms like LinkedIn interrupt a cookie session with "enter the 6-digit
-- code we just sent you". The worker keeps that Chromium session open, flips
-- the post to status 'awaiting_code', and polls sp_post.verification_code for a
-- code the user types into the UI (submitVerificationCode). Once it arrives the
-- worker fills it in the live page and finishes posting.
--
-- status is a free-text column, so 'awaiting_code' needs no enum change.

alter table public.sp_post
  add column if not exists verification_code text,
  add column if not exists verification_prompt text,
  add column if not exists verification_requested_at timestamptz;
