-- Persist the Markdown rendering of each audit so the public report page can
-- show it directly (and a raw .md file can be served at /r/{token}/report.md).
alter table public.audits add column if not exists report_markdown text;

-- Refresh the public RPC to include the markdown.
-- The return signature changes (new column), so CREATE OR REPLACE is rejected
-- by Postgres — drop first.
drop function if exists public.get_public_audit(text);
create or replace function public.get_public_audit(token text)
returns table (
  id uuid,
  target_url text,
  status text,
  score int,
  summary jsonb,
  report_markdown text,
  completed_at timestamptz,
  created_at timestamptz
)
language sql security definer set search_path = public stable as $$
  select id, target_url, status, score, summary, report_markdown, completed_at, created_at
  from public.audits
  where share_token = token
  limit 1;
$$;

grant execute on function public.get_public_audit(text) to anon, authenticated;
