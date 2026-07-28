import { describe, it, expect } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerPromoteTools } from "@/lib/mcp/promote";

// Verifies the Promote module registers against the REAL MCP SDK and that a
// client can discover the tools + their input schemas over an in-memory
// transport (no DB — tool handlers aren't invoked by tools/list).
describe("crawlproof MCP · promote module", () => {
  it("exposes the promote toolset over the MCP protocol", async () => {
    const server = new McpServer({ name: "crawlproof-test", version: "0.0.0" });
    registerPromoteTools(server);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await client.connect(clientTransport);

    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "generate_promo_post",
      "list_accounts",
      "post_to_socials",
      "promote_url",
    ]);

    // promote_url is the one-shot the user story wants: it takes a url.
    const promote = tools.find((t) => t.name === "promote_url");
    expect(promote?.description).toMatch(/publish/i);
    const props = (promote?.inputSchema as { properties?: Record<string, unknown> })?.properties;
    expect(props?.url).toBeDefined();
    expect(props?.account_ids).toBeDefined();

    await client.close();
    await server.close();
  });
});
