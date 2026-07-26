-- Sender postal address for cold outreach.
--
-- CAN-SPAM §7704(a)(5) requires a valid physical postal address in every
-- commercial email. That was an env var (OUTREACH_POSTAL_ADDRESS), which is
-- wrong for two reasons: it takes a redeploy to change, and it forces one
-- address on every user of the instance — an agency sending on behalf of
-- three clients has three different addresses to put in the footer.
--
-- Three levels, resolved most-specific-first at send time:
--
--   project       this project's outreach signs with its own address
--   organization  everything the org sends, unless a project overrides
--   account       the personal default, set once in Settings
--
-- The env var stays as a last-resort fallback so existing deployments keep
-- working, but nothing needs it any more.

alter table public.profiles
  add column if not exists outreach_postal_address text;

alter table public.organizations
  add column if not exists outreach_postal_address text;

alter table public.projects
  add column if not exists outreach_postal_address text;

comment on column public.profiles.outreach_postal_address is
  'Default physical postal address used in the CAN-SPAM footer of cold '
  'outreach email. Overridden by the org and then the project.';

comment on column public.organizations.outreach_postal_address is
  'Org-wide postal address for cold outreach. Overrides the owner''s '
  'personal default; overridden by a per-project address.';

comment on column public.projects.outreach_postal_address is
  'Per-project postal address for cold outreach. Most specific level — an '
  'agency sending for several clients signs each with the right address.';
