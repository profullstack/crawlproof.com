-- Keep one global SMSHub sender and one global CoinPay Portal billing
-- connection. These platform connections are managed from /dashboard/admin.

create unique index if not exists integrations_smshub_platform_unique
  on public.integrations(provider, name)
  where org_id is null
    and provider = 'smshub'
    and name = 'outbound-sms';

create unique index if not exists integrations_coinpayportal_platform_unique
  on public.integrations(provider, name)
  where org_id is null
    and provider = 'coinpayportal'
    and name = 'crawlproof-billing';
