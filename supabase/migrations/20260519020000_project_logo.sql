-- Cache the customer site's logo URL on the project row so the
-- dashboard can show a thumbnail without re-fetching the site on
-- every render.
--
-- Population: writeable via the service client from a server action
-- (lib/discoverLogo.ts) that fetches the project URL and picks the
-- best <link rel="apple-touch-icon"> / <link rel="icon"> / og:image
-- per page. Backfilled lazily on dashboard render for existing rows.

alter table public.projects
  add column if not exists logo_url text;

create index if not exists projects_logo_url_null_idx
  on public.projects (id)
  where logo_url is null;
