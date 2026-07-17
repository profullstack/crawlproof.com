// CrawlProof MCP server — a real Model Context Protocol server (official
// @modelcontextprotocol/sdk via the mcp-handler Next adapter) mounted on the
// existing app at https://crawlproof.com/api/mcp. Agents connect here with a
// crp_ API token (Authorization: Bearer crp_…) and get the Promote toolset.
//
// Add capabilities by registering more tool modules in the initializer below.

import { createMcpHandler, withMcpAuth } from "mcp-handler";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { authenticateToken } from "@/lib/sp/apiAuth";
import { registerPromoteTools } from "@/lib/mcp/promote";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const handler = createMcpHandler((server) => {
  registerPromoteTools(server);
});

// Resolve the crp_ bearer token to a CrawlProof user; stash the user id on the
// AuthInfo so tool handlers can scope to the caller. Returning undefined (with
// required:true) makes mcp-handler answer 401.
async function verifyToken(_req: Request, bearerToken?: string): Promise<AuthInfo | undefined> {
  if (!bearerToken) return undefined;
  const auth = await authenticateToken(bearerToken);
  if (!auth.ok) return undefined;
  return {
    token: bearerToken,
    clientId: auth.userId,
    scopes: [],
    extra: { userId: auth.userId },
  };
}

const authHandler = withMcpAuth(handler, verifyToken, { required: true });

export { authHandler as GET, authHandler as POST, authHandler as DELETE };
