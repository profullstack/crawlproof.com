-- Recent outreach can now publish through connected social accounts and
-- org outreach sender secrets move into encrypted columns for new writes.

alter table public.recent_outreach_messages
  add column if not exists social_post_id uuid references public.sp_post(id) on delete set null;

create index if not exists recent_outreach_social_post_idx
  on public.recent_outreach_messages(social_post_id)
  where social_post_id is not null;

alter table public.organization_outreach_configs
  add column if not exists enc_smtp_user text,
  add column if not exists enc_smtp_pass text,
  add column if not exists enc_api_key text,
  add column if not exists enc_auth_token text;

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
      and cls.relname = 'sp_post'
      and att.attname = 'source'
  loop
    execute format('alter table public.sp_post drop constraint %I', c);
  end loop;
end$$;

alter table public.sp_post
  add constraint sp_post_source_check
  check (source in ('autoblog','manual','rss','sitemap','api','outreach'));
