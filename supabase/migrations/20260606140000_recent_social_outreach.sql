-- Social/manual outreach for Recent scans.

alter table public.recent_outreach_messages
  add column if not exists visibility text not null default 'private'
    check (visibility in ('private', 'public'));

alter table public.recent_outreach_messages
  drop constraint if exists recent_outreach_messages_channel_check;

alter table public.recent_outreach_messages
  add constraint recent_outreach_messages_channel_check
  check (channel in ('email', 'sms', 'social'));

alter table public.recent_outreach_messages
  drop constraint if exists recent_outreach_messages_status_check;

alter table public.recent_outreach_messages
  add constraint recent_outreach_messages_status_check
  check (status in ('sent', 'failed', 'queued'));
