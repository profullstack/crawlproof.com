// WebMCP plugin config (projects.webmcp_config) as served to /stats.js.
// Only the embed's known options pass, as strings / arrays / objects of strings,
// so nothing else stored in the column can leak to the public endpoint.

const STRING_KEYS = ["mcp", "mcpPrefix", "search", "searchApi", "searchDescription", "name", "description"] as const;

export function publicWebmcpConfig(raw: unknown): Record<string, unknown> {
  const src = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const out: Record<string, unknown> = {};
  for (const k of STRING_KEYS) {
    const v = src[k];
    if (typeof v === "string" && v.trim()) out[k] = v.trim().slice(0, 300);
  }
  if (Array.isArray(src.mcpExclude)) {
    out.mcpExclude = src.mcpExclude.filter((x): x is string => typeof x === "string").slice(0, 50);
  }
  if (src.pages && typeof src.pages === "object" && !Array.isArray(src.pages)) {
    const pages: Record<string, string> = {};
    for (const [label, path] of Object.entries(src.pages as Record<string, unknown>).slice(0, 20)) {
      if (typeof path === "string" && path.startsWith("/")) pages[label.slice(0, 60)] = path.slice(0, 300);
    }
    if (Object.keys(pages).length) out.pages = pages;
  }
  return out;
}
