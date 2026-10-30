-- Surveys are workspace-owned and project-scoped. Public visitors only touch
-- them through server routes; no anon table policies expose contact details.

create table if not exists public.surveys (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  owner_id uuid not null references public.profiles(id) on delete cascade,
  slug text not null unique,
  title text not null,
  question text not null,
  answer_type text not null default 'rating'
    check (answer_type in ('rating', 'text')),
  status text not null default 'live'
    check (status in ('draft', 'live', 'paused')),
  -- Invitation copy variants are assigned deterministically per recipient.
  variants jsonb not null default '[]'::jsonb
    check (jsonb_typeof(variants) = 'array'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists surveys_org_created_idx
  on public.surveys(organization_id, created_at desc);
create index if not exists surveys_project_created_idx
  on public.surveys(project_id, created_at desc);

alter table public.surveys enable row level security;

create table if not exists public.survey_invites (
  id uuid primary key default gen_random_uuid(),
  survey_id uuid not null references public.surveys(id) on delete cascade,
  variant_key text not null,
  recipient_hash text not null,
  invite_token text not null unique default encode(gen_random_bytes(24), 'hex'),
  email text,
  phone text,
  email_consent boolean not null default false,
  sms_consent boolean not null default false,
  consent_at timestamptz not null,
  consent_source text not null default 'survey_form',
  requested_channel text not null check (requested_channel in ('email', 'sms')),
  delivery_channel text check (delivery_channel in ('email', 'sms')),
  delivery_status text not null default 'sending'
    check (delivery_status in ('sending', 'sent', 'failed', 'responded')),
  provider text,
  provider_message_id text,
  delivery_error text,
  ip_hash text,
  created_at timestamptz not null default now(),
  check (email_consent or sms_consent)
);

create unique index if not exists survey_invites_recipient_idx
  on public.survey_invites(survey_id, recipient_hash);
create index if not exists survey_invites_survey_created_idx
  on public.survey_invites(survey_id, created_at desc);
create index if not exists survey_invites_ip_created_idx
  on public.survey_invites(ip_hash, created_at desc)
  where ip_hash is not null;

alter table public.survey_invites enable row level security;

create table if not exists public.survey_responses (
  id uuid primary key default gen_random_uuid(),
  survey_id uuid not null references public.surveys(id) on delete cascade,
  invite_id uuid not null unique references public.survey_invites(id) on delete cascade,
  variant_key text not null,
  rating smallint check (rating between 1 and 5),
  answer_text text check (char_length(answer_text) <= 4000),
  created_at timestamptz not null default now(),
  check ((rating is not null) <> (answer_text is not null))
);

create index if not exists survey_responses_survey_created_idx
  on public.survey_responses(survey_id, created_at desc);

alter table public.survey_responses enable row level security;

drop trigger if exists surveys_set_updated_at on public.surveys;
create trigger surveys_set_updated_at
  before update on public.surveys
  for each row execute function public.lx_set_updated_at();

comment on table public.surveys is
  'Project-scoped survey links, invitation variants and response collection.';
comment on table public.survey_invites is
  'Consent-bearing one-time invitations. Contact values are cleared after each delivery attempt; keyed hashes remain for stable assignment and deduplication.';
