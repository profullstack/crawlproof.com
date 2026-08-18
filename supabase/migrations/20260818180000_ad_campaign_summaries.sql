-- Editorial summaries of the advertiser, for ads that live inside content.
--
-- The display formats all render the same tiny copy set: a headline, one
-- benefit line of ~76 characters, and a call to action. That is the right size
-- for a 300x250 box and far too little for a placement that sits *inside*
-- somebody's writing — a sponsored paragraph in a blog post, or the long-form
-- body of a feed item, where the ad is read rather than glanced at.
--
-- So a campaign now also carries prose, in two lengths:
--
--   summary_short  one or two sentences. The inline mention: enough for a card
--                  body or a "this post is sponsored by" line.
--   summary_long   a few short paragraphs. The blog-post form.
--
-- These belong on the campaign rather than on a creative because they describe
-- the *advertiser*, not a format. Every creative of a campaign shares them, and
-- a campaign has exactly one destination to describe.
--
-- summary_domain records which domain the prose was written from. That is what
-- makes the pair trustworthy over time: a campaign's destination_url can be
-- edited after the fact, and a summary describing a site the campaign no longer
-- points at is worse than no summary. Serving compares the two and treats a
-- mismatch as absent, so an edited destination quietly falls back to the short
-- creative body until the copy is regenerated.
--
-- NOTE: prod migration history diverged — apply this single file via psql over
-- the pooler or the Supabase MCP, do NOT `supabase db push`.

alter table public.ad_campaigns
  add column if not exists summary_short text,
  add column if not exists summary_long text,
  add column if not exists summary_domain text,
  add column if not exists summary_generated_at timestamptz;

comment on column public.ad_campaigns.summary_short is
  'One or two sentences describing the advertiser, for an inline sponsored mention. Written from summary_domain.';
comment on column public.ad_campaigns.summary_long is
  'A few short paragraphs, for a sponsored blog-post body. Written from summary_domain. Paragraphs are separated by a blank line.';
comment on column public.ad_campaigns.summary_domain is
  'The domain the summaries were written from. Serving ignores the summaries when this does not match destination_domain.';
