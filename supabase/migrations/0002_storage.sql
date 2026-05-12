-- Storage buckets for audit artifacts.
-- These are private; access via signed URLs from the server.

insert into storage.buckets (id, name, public)
values ('audit-artifacts', 'audit-artifacts', false)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public)
values ('pdf-reports', 'pdf-reports', false)
on conflict (id) do nothing;

-- Owners can read their own artifacts. Path convention: `{audit_id}/...`
create policy "artifact owner read"
  on storage.objects for select
  using (
    bucket_id in ('audit-artifacts','pdf-reports')
    and exists (
      select 1 from public.audits a
      where a.id::text = split_part(name, '/', 1)
        and a.owner_id = auth.uid()
    )
  );
