import { describe, it, expect } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerAuditTools } from "@/lib/mcp/audits";

// The async audit tools register against the real SDK and are discoverable
// over the MCP protocol (handlers aren't invoked by tools/list, so no DB/worker).
describe("crawlproof MCP · audits module", () => {
  it("exposes start_audit + get_audit", async () => {
    const server = new McpServer({ name: "crawlproof-test", version: "0.0.0" });
    registerAuditTools(server);

    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await client.connect(ct);

    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["get_audit", "start_audit"]);

    const start = tools.find((t) => t.name === "start_audit");
    const props = (start?.inputSchema as { properties?: Record<string, unknown> })?.properties;
    expect(props?.url).toBeDefined();
    expect(props?.engines).toBeDefined();

    const get = tools.find((t) => t.name === "get_audit");
    const gp = (get?.inputSchema as { properties?: Record<string, unknown> })?.properties;
    expect(gp?.run_id).toBeDefined();

    await client.close();
    await server.close();
  });
});
