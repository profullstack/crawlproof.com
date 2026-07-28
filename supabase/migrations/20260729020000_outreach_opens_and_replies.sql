-- Close the outreach loop: what got opened, and what came back.
--
-- Until now the only measurable event was the send. Everything after it —
-- opened, replied, won — depended on somebody remembering to mark it by hand,
-- so a funnel left alone reported a reply rate of structurally zero. These two
-- columns' worth of bookkeeping is what turns it into a measurement.

-- ------------------------------------------------------------------- opens

-- Per send, never per campaign. A campaign-level pixel can tell you that
-- somebody opened something, which is not a fact anybody can act on.
alter table public.outreach_sends
  add column if not exists track_token text,
  add column if not exists opened_at timestamptz,
  add column if not exists last_opened_at timestamptz,
  add column if not exists open_count integer not null default 0,
  -- Mail privacy proxies fetch every image the instant a message arrives,
  -- before a human has seen anything. Keeping the discarded ones visible is
  -- the difference between a number that is wrong and a number that is
  -- honest about its own error bar.
  add column if not exists prefetch_count integer not null default 0;

create unique index if not exists outreach_sends_track_token_idx
  on public.outreach_sends (track_token)
  where track_token is not null;

comment on column public.outreach_sends.track_token is
  'Per-send opaque token behind the tracking pixel URL. Null for dry runs and for sends that predate open tracking.';
comment on column public.outreach_sends.prefetch_count is
  'Image loads discarded as proxy prefetch rather than counted as opens.';

-- ----------------------------------------------------------------- replies

alter table public.outreach_prospects
  add column if not exists replied_at timestamptz;

-- The reply itself, not just the fact of one. "Did anyone answer" is
-- answerable from a status; "what did they say" is the question that decides
-- what to do next, and it is the reason to keep the row.
create table if not exists public.outreach_replies (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete cascade,
  owner_id uuid not null references public.profiles(id) on delete cascade,
  prospect_id uuid references public.outreach_prospects(id) on delete set null,
  send_id uuid references public.outreach_sends(id) on delete set null,

  from_email text not null,
  subject text,
  -- A short excerpt, not the message. Enough to tell "interested" from "take
  -- me off this list" in a list view without storing somebody's whole mail.
  snippet text,
  message_id text,
  received_at timestamptz not null,
  -- Auto-replies are recorded and flagged rather than dropped: an out-of-
  -- office is a real fact about the recipient, and counting it as a reply
  -- would inflate the one rate the funnel exists to report.
  auto_reply boolean not null default false,
  created_at timestamptz not null default now()
);

-- Message-Id is unique per message, so scanning the same mailbox twice cannot
-- record the same reply twice. Scoped by owner because two accounts may each
-- legitimately hold a copy of the same message.
create unique index if not exists outreach_replies_message_idx
  on public.outreach_replies (owner_id, message_id)
  where message_id is not null;

create index if not exists outreach_replies_project_idx
  on public.outreach_replies (project_id, received_at desc);

comment on table public.outreach_replies is
  'Replies matched to outreach by scanning the connected mailbox over IMAP. Auto-replies are flagged, not counted.';

-- Where the last scan got to, so a scan reads new mail rather than the whole
-- mailbox. Per mailbox, because that is what the cursor describes.
alter table public.organization_outreach_configs
  add column if not exists last_reply_scan_at timestamptz,
  add column if not exists reply_scan_error text;
