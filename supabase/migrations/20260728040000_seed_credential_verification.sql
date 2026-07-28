-- Human-in-the-loop verification codes for seed logins.
--
-- A gated directory will interrupt a sign-in with "enter the six-digit code we
-- just sent you". The server cannot answer that, and should not be able to —
-- the point of the code is that it reaches the account's owner. But the owner
-- is right there, so the browser session stays open, the prompt is surfaced in
-- the UI, and the code they type gets entered into the live page.
--
-- Mirrors the columns sp_post already uses for exactly this
-- (lib/sp/verificationChallenge.ts), so the same generic detector and handler
-- drive both.

alter table public.outreach_seed_credentials
  -- What the site is asking, verbatim enough for the user to know which
  -- inbox or device to check.
  add column if not exists verification_prompt text,
  -- The code the user submits. Cleared the moment it is consumed, so it
  -- cannot be replayed.
  add column if not exists verification_code text,
  add column if not exists verification_requested_at timestamptz;

comment on column public.outreach_seed_credentials.verification_code is
  'One-time code entered by the user during a live sign-in. Cleared immediately after use; never a stored secret.';

comment on column public.outreach_seed_credentials.verification_prompt is
  'What the site asked for, shown in the UI. Non-null means a sign-in is paused waiting on the user.';
