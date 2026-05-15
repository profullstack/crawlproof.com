-- Capture the LLM-generated excerpt separately from meta_description.
-- meta_description is SEO copy capped at ~160 chars; excerpt is the
-- prose summary shown above the post in feed-style consumers (up to
-- ~240 chars). Storing it lets the webhook payload carry both, so
-- receivers can pick whichever fits their template.

alter table public.lx_article
  add column if not exists excerpt text;
