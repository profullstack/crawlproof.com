// Every CrawlProof MCP tool reaches tools/list with a human title and all of
// the behaviour hints. Connector directories reject a server where any tool
// lacks them. Goes through the real SDK server and client, because the SDK's
// own tools/list mapper is what decides whether title/annotations survive.
import { describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { TOOL_HINTS, withToolHints } from "@/lib/mcp/annotations";
import { registerPromoteTools } from "@/lib/mcp/promote";
import { registerStatsTools } from "@/lib/mcp/stats";
import { registerAuditTools } from "@/lib/mcp/audits";
import { registerLeadTools } from "@/lib/mcp/leads";
import { registerAutoblogTools } from "@/lib/mcp/autoblog";
import { registerAffiliateTools } from "@/lib/mcp/affiliate";
import { registerActorTools } from "@/lib/mcp/actors";
import { registerCreditTools } from "@/lib/mcp/credits";
import { registerWebhookTools } from "@/lib/mcp/webhooks";
import { registerTrendTools } from "@/lib/mcp/trends";

async function listTools() {
  const server = new McpServer({ name: "crawlproof-test", version: "0" });
  withToolHints(server);
  for (const register of [
    registerPromoteTools, registerStatsTools, registerAuditTools, registerLeadTools, registerAutoblogTools,
    registerAffiliateTools, registerActorTools, registerCreditTools, registerWebhookTools, registerTrendTools,
  ]) register(server);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(b);
  const { tools } = await client.listTools();
  await client.close();
  return tools;
}

describe("MCP tool annotations", () => {
  it("every listed tool has a title and readOnly/destructive/idempotent/openWorld hints", async () => {
    const tools = await listTools();
    expect(tools.length).toBe(51);
    expect(tools.map((t) => t.name).sort()).toEqual(Object.keys(TOOL_HINTS).sort());
    for (const t of tools) {
      expect(t.title, t.name).toBeTruthy();
      expect(t.annotations?.title, t.name).toBe(t.title);
      for (const k of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const) {
        expect(typeof t.annotations?.[k], `${t.name}.${k}`).toBe("boolean");
      }
      if (t.annotations?.readOnlyHint) expect(t.annotations.destructiveHint, t.name).toBe(false);
    }
  });

  it("publishing, sending, spending and deleting tools are destructive", () => {
    for (const n of ["post_to_socials", "promote_url", "send_message", "autoblog_post", "affiliate_payout", "delete_webhook"]) {
      expect(TOOL_HINTS[n].destructiveHint, n).toBe(true);
      expect(TOOL_HINTS[n].readOnlyHint, n).toBe(false);
    }
  });

  it("an unannotated tool fails at registration", () => {
    const server = new McpServer({ name: "t", version: "0" });
    withToolHints(server);
    expect(() => server.registerTool("no_such_tool", { description: "x" }, async () => ({ content: [] }))).toThrow(/no title/);
  });
});
