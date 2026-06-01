// Calls the specification.website MCP server (Streamable HTTP, 2025-03-26)
// to generate an audit plan for a target URL and returns the markdown text.
// Best-effort: returns null on any network / protocol error so the caller
// can degrade gracefully.

const MCP_ENDPOINT = "https://mcp.specification.website/mcp";
const TIMEOUT_MS = 20_000;

async function mcpPost(
  body: object,
  sessionId?: string,
): Promise<{ data: unknown; sessionId?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const hdrs: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    if (sessionId) hdrs["mcp-session-id"] = sessionId;

    const res = await fetch(MCP_ENDPOINT, {
      method: "POST",
      headers: hdrs,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const newSession = res.headers.get("mcp-session-id") ?? undefined;
    const ct = res.headers.get("content-type") ?? "";
    const text = await res.text();

    // SSE — pick the first data line that is a JSON-RPC response.
    if (ct.includes("text/event-stream")) {
      for (const line of text.split(/\r?\n/)) {
        if (line.startsWith("data: ")) {
          try {
            return { data: JSON.parse(line.slice(6)), sessionId: newSession };
          } catch {
            /* skip malformed line */
          }
        }
      }
      return { data: null, sessionId: newSession };
    }

    try {
      return { data: JSON.parse(text), sessionId: newSession };
    } catch {
      return { data: null, sessionId: newSession };
    }
  } finally {
    clearTimeout(timer);
  }
}

function extractText(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const rpc = data as Record<string, unknown>;
  const result = rpc["result"];
  if (!result || typeof result !== "object") return null;
  const r = result as Record<string, unknown>;
  const content = r["content"];
  if (!Array.isArray(content)) return null;
  const parts = (content as Array<{ type?: string; text?: string }>)
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string);
  return parts.length > 0 ? parts.join("\n") : null;
}

export async function fetchSpecAuditPlan(targetUrl: string): Promise<string | null> {
  try {
    // 1. Initialize — get session ID and confirm server capabilities.
    const initRes = await mcpPost({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "CrawlProof", version: "1.0" },
      },
    });

    const sessionId = initRes.sessionId;

    // 2. Notify server that client is initialized (required by MCP spec).
    if (sessionId) {
      await mcpPost(
        { jsonrpc: "2.0", method: "notifications/initialized" },
        sessionId,
      );
    }

    // 3. Call audit_url tool.
    const toolRes = await mcpPost(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "audit_url",
          arguments: { url: targetUrl },
        },
      },
      sessionId,
    );

    return extractText(toolRes.data);
  } catch (err) {
    console.warn("[spec-mcp] audit_url failed:", err instanceof Error ? err.message : err);
    return null;
  }
}
