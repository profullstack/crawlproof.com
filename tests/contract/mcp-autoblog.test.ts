import { describe, it, expect } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerAutoblogTools } from "@/lib/mcp/autoblog";

// The autoblog tools register against the real SDK and are discoverable over
// the MCP protocol. Handlers are not invoked by tools/list, so no DB or worker
// is touched here; this pins the tool surface and each tool's input schema.
describe("crawlproof MCP · autoblog module", () => {
  it("exposes the autoblog toolset", async () => {
    const server = new McpServer({ name: "crawlproof-test", version: "0.0.0" });
    registerAutoblogTools(server);

    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await client.connect(ct);

    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "autoblog_articles",
      "autoblog_guest_post",
      "autoblog_link_exchange",
      "autoblog_post",
      "autoblog_sites",
      "traffic",
    ]);

    const guest = tools.find((t) => t.name === "autoblog_guest_post");
    const props = (guest?.inputSchema as { properties?: Record<string, unknown> })?.properties;
    expect(props?.authorSiteId).toBeDefined();
    expect(props?.targetSiteId).toBeDefined();
    expect(props?.topic).toBeDefined();

    const traffic = tools.find((t) => t.name === "traffic");
    const tprops = (traffic?.inputSchema as { properties?: Record<string, unknown> })?.properties;
    expect(tprops?.site).toBeDefined();
    expect(tprops?.range).toBeDefined();
    expect(tprops?.who).toBeDefined();

    await client.close();
    await server.close();
  });
});
