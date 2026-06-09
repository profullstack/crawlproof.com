-- Platform-level Vu1nz API credentials live in integrations, managed from /admin.
-- org_id is null for platform credentials, so add an explicit partial unique
-- index for the singleton row used by the scanner.

create unique index if not exists integrations_vu1nz_platform_unique
  on public.integrations(provider, name)
  where org_id is null
    and provider = 'vu1nz'
    and name = 'website-scanner';
