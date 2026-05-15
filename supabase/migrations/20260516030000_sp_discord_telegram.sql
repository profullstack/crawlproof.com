-- Allow 'discord' and 'telegram' as platform values on sp_account.
--
-- Both ship as Phase 1.4 social-posting platforms. Auth shapes:
--   - Discord: a per-channel webhook URL (no OAuth, no app review). The
--     URL itself IS the secret — stored AES-GCM-encrypted in
--     enc_access_token. handle = channel name, external_id = the
--     numeric channel_id returned by GET /webhooks/{id}/{token}.
--   - Telegram: a bot token from @BotFather + a channel ID the bot was
--     made admin in. Token goes in enc_access_token; channel id +
--     @username live in external_id (numeric id) + handle (display).
--
-- No new columns needed — both fit the existing sp_account shape.

-- Drop whatever CHECK constraint currently restricts sp_account.platform
-- (Postgres auto-named it `sp_account_platform_check` for the inline
-- `check (...)` in the original create-table; this DO block stays
-- correct even if someone renamed it). Then re-add with the extra
-- platform values.
do $$
declare
  c text;
begin
  for c in
    select con.conname
    from pg_constraint con
    join pg_class cls on cls.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = cls.relnamespace
    join pg_attribute att
      on att.attrelid = cls.oid
     and att.attnum = any(con.conkey)
    where con.contype = 'c'
      and nsp.nspname = 'public'
      and cls.relname = 'sp_account'
      and att.attname = 'platform'
  loop
    execute format('alter table public.sp_account drop constraint %I', c);
  end loop;
end$$;

alter table public.sp_account
  add constraint sp_account_platform_check
  check (platform in (
    'bluesky','mastodon','reddit','linkedin','threads','pinterest','tumblr',
    'x','facebook_page','instagram_business','youtube',
    'tiktok','instagram','snapchat',
    'discord','telegram'
  ));
