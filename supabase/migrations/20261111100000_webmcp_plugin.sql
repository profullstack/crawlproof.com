-- WebMCP plugin: an opt-in module of the drop-in tracker (/stats.js).
-- With webmcp_enabled, the same snippet loads @profullstack/webmcp in browsers
-- that ship WebMCP (document.modelContext), so an AI agent in the visitor's
-- browser gets site_info, open_page, search and form tools, plus the site's own
-- MCP server when webmcp_config.mcp names it. A data-webmcp attribute on the tag
-- still works without this flag; data-webmcp="off" on the tag always wins.
--
-- webmcp_config holds the embed's options: mcp, mcpPrefix, mcpExclude (array),
-- search, searchApi, searchDescription, pages (object), name, description.
-- Served publicly by /api/tracker/v1/webmcp, so it must never hold secrets.

alter table public.projects
  add column if not exists webmcp_enabled boolean not null default false;

alter table public.projects
  add column if not exists webmcp_enabled_at timestamptz;

alter table public.projects
  add column if not exists webmcp_config jsonb not null default '{}'::jsonb;
