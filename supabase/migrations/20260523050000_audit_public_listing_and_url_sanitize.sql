-- Make Recent scans opt-in and sanitize historical audit URLs.

alter table public.audits
  add column if not exists listed_public boolean not null default false;

create index if not exists audits_recent_listed_public_idx
  on public.audits(completed_at desc)
  where owner_id is null
    and listed_public = true
    and status = 'complete'
    and share_token is not null;

create or replace function public.strip_common_tracking_params(input_url text)
returns text
language plpgsql
immutable
as $$
declare
  no_hash text;
  base text;
  query text;
  part text;
  key text;
  kept text[] := array[]::text[];
begin
  if input_url is null or input_url = '' then
    return input_url;
  end if;

  no_hash := split_part(input_url, '#', 1);

  if position('?' in no_hash) = 0 then
    return no_hash;
  end if;

  base := split_part(no_hash, '?', 1);
  query := substring(no_hash from position('?' in no_hash) + 1);

  foreach part in array string_to_array(query, '&')
  loop
    key := lower(split_part(part, '=', 1));
    if key = '' then
      continue;
    end if;
    if key like 'utm\_%' escape '\'
      or key in (
        'fbclid',
        'gclid',
        'gbraid',
        'wbraid',
        'msclkid',
        'mc_cid',
        'mc_eid',
        'igshid',
        'li_fat_id',
        'ref'
      )
    then
      continue;
    end if;
    kept := array_append(kept, part);
  end loop;

  if array_length(kept, 1) is null then
    return base;
  end if;

  return base || '?' || array_to_string(kept, '&');
end;
$$;

update public.audits
set target_url = public.strip_common_tracking_params(target_url)
where target_url like '%?%' or target_url like '%#%';
