-- Scan connected mailboxes for replies.
--
-- Every twenty minutes. A reply is not urgent — nobody is going to answer it
-- inside the window either way — but it does gate the follow-up sequence, and
-- a campaign that keeps chasing someone who already answered is the specific
-- failure this is meant to prevent. Twenty minutes is short enough that the
-- next tick's follow-ups see it.
--
-- Offset from the outreach cron so a mailbox is not being read and written in
-- the same instant.

select cron.schedule(
  'crawlproof-outreach-replies',
  '11,31,51 * * * *',
  $$
  select net.http_post(
    url := (select value from public.cron_config where key = 'site_url') || '/api/cron/outreach-replies',
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'x-cron-secret', (select value from public.cron_config where key = 'cron_secret')
    ),
    body := '{}'::jsonb
  );
  $$
);
