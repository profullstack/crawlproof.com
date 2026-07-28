-- What a campaign sells, in prose, and who to tell when somebody asks for it.
--
-- Keyword matching drops the best-phrased requests. "Our pipeline keeps
-- falling over under traffic" is exactly the person a load-testing campaign
-- wants and contains none of its keywords, because the people with the problem
-- describe the problem rather than the product category.
--
-- The description is also what makes a relevance judgement auditable: a model
-- deciding "is this person asking for what you sell" needs a statement of what
-- you sell, and that statement is the thing a user can correct when the
-- judgement is wrong.
alter table public.outreach_campaigns
  add column if not exists sells_description text,
  -- Where to send an alert. Null falls back to the account email, so a
  -- campaign does not have to be configured to be useful.
  add column if not exists alert_email text,
  add column if not exists alerts_enabled boolean not null default true;

comment on column public.outreach_campaigns.sells_description is
  'Plain-prose description of what this campaign sells. Used to judge relevance for requests that avoid the campaign keywords.';

-- Which path qualified a signal, so a description match can explain itself to
-- a user who only ever listed keywords.
alter table public.outreach_intent_signals
  add column if not exists match_path text
    check (match_path is null or match_path in ('keyword', 'description')),
  -- Set once, when the signal has been included in an alert. The dedupe for
  -- "never tell someone twice" is this column, not a timestamp comparison.
  add column if not exists alerted_at timestamptz;

create index if not exists outreach_intent_signals_unalerted_idx
  on public.outreach_intent_signals (project_id)
  where alerted_at is null;

comment on column public.outreach_intent_signals.alerted_at is
  'When this signal was included in an alert. Null means unsent; this column is what stops a signal being alerted twice.';
