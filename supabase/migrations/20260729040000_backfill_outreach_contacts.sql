-- Backfill the shared contacts table from prospects already found.
--
-- outreach_contacts held nine rows against seventy-seven addressable leads.
-- Nearly every lead arrived through the scanning branch of researchProspect,
-- which wrote the address onto the prospect and nowhere else — so the table
-- meant to be the durable, cross-project record of who we know had almost
-- nothing in it, and the leads themselves were only reachable by reading
-- project-scoped prospect rows one project at a time.
--
-- The code path is fixed alongside this. This is the history it could not
-- reach: everything found before the fix existed.
--
-- Idempotent. Re-running inserts nothing new, because the unique index on
-- (organization_id, identity_key) already holds every row this would add.

with candidates as (
  select distinct on (pr.organization_id, lower(p.contact_email))
    pr.organization_id,
    lower(p.contact_email)                          as email,
    p.target_key                                    as host,
    -- What the listing called them. A company name far more often than a
    -- person's, which is why it is not written into full_name.
    nullif(p.discovery_label, '')                   as company_name,
    'https://' || p.target_key                      as company_site,
    -- The campaign that found them is the only statement of what they are
    -- that the pipeline can make without guessing: someone found by a
    -- campaign called "game designers" is a game designer.
    c.name                                          as niche,
    p.site_url                                      as source_url,
    -- Prefer the richest row when the same address appears in several
    -- projects: one that names the company beats one that does not.
    p.created_at
  from public.outreach_prospects p
  join public.projects pr on pr.id = p.project_id
  left join public.outreach_campaigns c on c.id = p.campaign_id
  where p.contact_email is not null
    and p.contact_email <> ''
    and p.channel = 'email'
    and pr.organization_id is not null
  order by pr.organization_id,
           lower(p.contact_email),
           (p.discovery_label is not null) desc,
           p.created_at asc
)
insert into public.outreach_contacts
  (organization_id, email, host, company_name, company_site, niche, source_url, first_seen_at)
select organization_id, email, host, company_name, company_site, niche, source_url, created_at
from candidates
-- identity_key is assigned by the before-insert trigger, so the partial index
-- it backs is the right conflict target here.
on conflict (organization_id, identity_key) where identity_key is not null
do nothing;

-- Point the prospects at the contact they belong to, so the link works both
-- ways rather than only for rows created after the fix.
update public.outreach_prospects p
set contact_id = c.id
from public.outreach_contacts c
join public.projects pr on pr.organization_id = c.organization_id
where pr.id = p.project_id
  and p.contact_email is not null
  and lower(p.contact_email) = lower(c.email)
  and p.contact_id is distinct from c.id;
