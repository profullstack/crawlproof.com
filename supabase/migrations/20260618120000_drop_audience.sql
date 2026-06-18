-- Remove the Audience feature (org mass-email import lists + the event-driven
-- Audience Hub contact graph). The feature is being retired: it collected
-- contact PII (emails, consent, identities) that is no longer used and is an
-- information-handling risk. This drops all tables and their data.
--
-- CASCADE handles the inter-table foreign keys (identities/links/events/consent
-- referencing audience_contacts, etc.) and any dependent policies/indexes.

-- Audience Hub (event-driven contact graph)
drop table if exists public.audience_consent_events cascade;
drop table if exists public.audience_events cascade;
drop table if exists public.audience_project_links cascade;
drop table if exists public.audience_identities cascade;
drop table if exists public.audience_contacts cascade;
drop table if exists public.project_api_keys cascade;

-- Org mass-email (data-source import lists + campaigns)
drop table if exists public.organization_email_campaigns cascade;
drop table if exists public.organization_audience_contacts cascade;
drop table if exists public.organization_data_sources cascade;
