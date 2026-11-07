import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { serviceClient } from "@/lib/supabase/service";
import { publicTrendList } from "@/lib/ads/trendList";

export function registerTrendTools(server: McpServer): void {
  server.registerTool(
    "list_trending_topics",
    {
      description:
        "Subjects blogs and news sites are writing about more than last week, the list trending ad targeting matches on. Feeds are counted in a sample, so read them as movement. `stale: true` means the list no longer steers delivery.",
      inputSchema: { limit: z.number().int().min(1).max(200).optional().describe("Default 50.") },
    },
    async (args) => {
      const list = await publicTrendList(serviceClient(), { limit: args.limit });
      return { content: [{ type: "text" as const, text: JSON.stringify(list, null, 2) }] };
    },
  );
}
