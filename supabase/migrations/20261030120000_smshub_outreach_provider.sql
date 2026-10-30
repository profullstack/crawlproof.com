-- Add SMSHub as an organization-level outbound SMS provider.

alter table public.organization_outreach_configs
  drop constraint if exists organization_outreach_configs_provider_check;

alter table public.organization_outreach_configs
  add constraint organization_outreach_configs_provider_check
  check (provider in ('smtp', 'resend', 'twilio', 'telnyx', 'smshub', 'manual'));
