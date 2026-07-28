import { describe, it, expect } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerStatsTools } from "@/lib/mcp/stats";

// The read-only stats tools register against the real SDK and are discoverable
// over the MCP protocol (handlers aren't invoked by tools/list, so no DB).
describe("crawlproof MCP · stats module", () => {
  it("exposes the read-only stats toolset", async () => {
    const server = new McpServer({ name: "crawlproof-test", version: "0.0.0" });
    registerStatsTools(server);

    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await client.connect(ct);

    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["ad_earnings", "list_projects", "promote_status", "recent_audits"]);

    const audits = tools.find((t) => t.name === "recent_audits");
    const props = (audits?.inputSchema as { properties?: Record<string, unknown> })?.properties;
    expect(props?.url).toBeDefined();
    expect(props?.limit).toBeDefined();

    await client.close();
    await server.close();
  });
});
