-- SSH login monitors: config holds { username, public_key, fingerprint }. The
-- worker asks the server whether it would accept the public key and hangs up
-- before signing (lib/ssh-auth-probe.ts), so no private key is ever stored.
alter table public.monitors drop constraint if exists monitors_type_check;
alter table public.monitors
  add constraint monitors_type_check
  check (type in ('http', 'ssh', 'keyword', 'ssl', 'tcp'));
