// Calls the specification.website MCP server (stateless HTTP, no auth).
// Endpoint: https://mcp.specification.website/mcp
//
// audit_url is a *prompt* (prompts/get), not a tool — it returns a list of
// messages containing the audit checklist text. The server needs no
// initialize handshake; every POST is independent.

const MCP_ENDPOINT = "https://mcp.specification.website/mcp";
const TIMEOUT_MS = 20_000;

async function mcpPost(body: object): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(MCP_ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

// Fetch the audit_url prompt for the given URL. Returns the checklist text
// from the first user-role message, or null on any error.
export async function fetchSpecAuditPlan(targetUrl: string): Promise<string | null> {
  try {
    const data = await mcpPost({
      jsonrpc: "2.0",
      id: 1,
      method: "prompts/get",
      params: {
        name: "audit_url",
        arguments: { url: targetUrl },
      },
    });

    if (!data || typeof data !== "object") return null;
    const rpc = data as Record<string, unknown>;
    if (rpc["error"]) {
      console.warn("[spec-mcp] prompts/get error:", rpc["error"]);
      return null;
    }
    const result = rpc["result"] as Record<string, unknown> | undefined;
    const messages = result?.["messages"] as Array<{ role: string; content: { type: string; text?: string } }> | undefined;
    if (!Array.isArray(messages)) return null;

    return messages
      .filter((m) => m.role === "user" && m.content?.type === "text" && m.content.text)
      .map((m) => m.content.text as string)
      .join("\n") || null;
  } catch (err) {
    console.warn("[spec-mcp] fetch failed:", err instanceof Error ? err.message : err);
    return null;
  }
}
