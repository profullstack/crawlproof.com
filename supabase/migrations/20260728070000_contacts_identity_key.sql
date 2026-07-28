-- Let a contact exist before their email does.
--
-- The table was keyed on email and required one, which assumed every person
-- arrives with an address. Person discovery does the opposite: a directory
-- gives a name, a title and a LinkedIn profile, and the address is what the
-- pipeline goes looking for afterwards. Under the old shape those people
-- could not be recorded at all, so each run rediscovered them from scratch.
--
-- identity_key is what a row is deduplicated on. It is the email when there
-- is one, because two records with the same address are the same person by
-- definition. Otherwise it is the name and employer, normalised — weaker,
-- but the alternative is a fresh row for the same human on every run.
--
-- Maintained by trigger rather than as a generated column: when an email is
-- finally found for a name-keyed contact, the key has to change from the
-- name form to the email form, and a generated column cannot be updated
-- through that transition without rewriting the row.

alter table public.outreach_contacts
  alter column email drop not null;

alter table public.outreach_contacts
  add column if not exists identity_key text;

create or replace function public.outreach_contact_identity()
returns trigger
language plpgsql
as $$
begin
  if new.email is not null and btrim(new.email) <> '' then
    new.identity_key := 'email:' || lower(btrim(new.email));
  elsif new.full_name is not null and btrim(new.full_name) <> '' then
    -- Name plus employer, punctuation and case removed. Weak on its own,
    -- which is why it is only used when there is no address to key on.
    new.identity_key := 'name:' ||
      regexp_replace(lower(btrim(new.full_name)), '[^a-z0-9]+', '', 'g') ||
      '@' ||
      coalesce(regexp_replace(lower(btrim(new.company_name)), '[^a-z0-9]+', '', 'g'), '');
  else
    new.identity_key := null;
  end if;
  return new;
end;
$$;

drop trigger if exists outreach_contacts_set_identity on public.outreach_contacts;
create trigger outreach_contacts_set_identity
  before insert or update on public.outreach_contacts
  for each row execute function public.outreach_contact_identity();

-- Backfill before the unique index goes on.
update public.outreach_contacts set updated_at = updated_at;

-- Replaces the email-only index: that one could not hold a person who has no
-- address, and would have treated every one of them as the same null.
drop index if exists outreach_contacts_org_email_idx;
create unique index if not exists outreach_contacts_org_identity_idx
  on public.outreach_contacts(organization_id, identity_key)
  where identity_key is not null;

comment on column public.outreach_contacts.identity_key is
  'Dedupe key: email when known, otherwise normalised name+employer. Maintained by trigger so it can change form when an address is finally found.';
