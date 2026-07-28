-- Connected mailboxes: a user hands us one address and one password, and
-- autodiscovery fills in the rest (lib/outreach/mailboxDiscovery.ts).
--
-- The SMTP half already had columns on this table. IMAP is new — it is stored
-- at connect time even though nothing reads it yet, because it is discovered
-- in the same exchange and re-prompting for a password later to learn a
-- hostname we already knew would be a poor trade.
--
-- The password itself lives only in enc_smtp_pass, AES-256-GCM via
-- lib/sp/vault.ts. No plaintext column is ever written for a mailbox.

alter table public.organization_outreach_configs
  add column if not exists imap_host text,
  add column if not exists imap_port int,
  add column if not exists imap_secure boolean,
  add column if not exists imap_user text,
  -- How the settings were arrived at (srv / autoconfig-cname / mx-provider /
  -- convention / manual), kept so the UI can say where they came from and so
  -- a later support question has an answer.
  add column if not exists discovery_source text,
  add column if not exists discovery_detail text,
  add column if not exists verified_at timestamptz;

comment on column public.organization_outreach_configs.discovery_source is
  'How IMAP/SMTP settings were determined: srv | autoconfig | autoconfig-cname | well-known | autodiscover | autodiscover-cname | ispdb | mx-provider | convention | manual';

comment on column public.organization_outreach_configs.verified_at is
  'Last time these credentials completed a live SMTP (and where applicable IMAP) login.';
