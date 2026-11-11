// CrawlProof MCP server — a real Model Context Protocol server (official
// @modelcontextprotocol/sdk via the mcp-handler Next adapter) mounted on the
// existing app at https://crawlproof.com/api/mcp. Agents connect here with a
// crp_ API token (Authorization: Bearer crp_…) or an OAuth 2.1 access token
// (crp_oat_…, lib/mcp-oauth.ts) that ChatGPT, claude.ai and Claude Code obtain
// themselves via dynamic client registration + PKCE. Any request without a
// valid credential is 401 + WWW-Authenticate resource_metadata, which is what
// starts the OAuth flow in those clients.
//
// Add capabilities by registering more tool modules in the initializer below.

import { createMcpHandler, withMcpAuth } from "mcp-handler";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { authenticateToken } from "@/lib/sp/apiAuth";
import { ACCESS_PREFIX, resolveAccessToken, siteOrigin } from "@/lib/mcp-oauth";
import { serviceClient } from "@/lib/supabase/service";
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

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const handler = createMcpHandler(
  (server) => {
    registerPromoteTools(server);
    registerStatsTools(server);
    registerAuditTools(server);
    registerLeadTools(server);
    registerAutoblogTools(server);
    registerAffiliateTools(server);
    registerActorTools(server);
    registerCreditTools(server);
    registerWebhookTools(server);
    registerTrendTools(server);
    addListCacheFields(server);
  },
  {},
  // The route is mounted at /api/mcp, so mcp-handler must derive its endpoint
  // from basePath "/api" (streamable HTTP → /api/mcp). Without this it looks for
  // "/mcp" and returns 404 on every real MCP call. maxDuration covers a
  // promote_url that generates + posts across several accounts.
  { basePath: "/api", maxDuration: 120 },
);

type ListHandler = (req: unknown, extra: unknown) => Promise<Record<string, unknown>>;

// Claude Code's MCP client (revision 2026-07-28) rejects a tools/list result
// without resultType + ttlMs + cacheScope ("connected · tools fetch failed").
// The SDK does not add them, so wrap its tools/list handler.
function addListCacheFields(server: { server: unknown }) {
  const handlers = (server.server as { _requestHandlers?: Map<string, ListHandler> })._requestHandlers;
  const original = handlers?.get("tools/list");
  if (!handlers || !original) return;
  handlers.set("tools/list", async (req, extra) => ({
    ...(await original(req, extra)),
    resultType: "complete",
    ttlMs: 300_000,
    cacheScope: "private",
  }));
}

// Resolve the crp_ bearer token to a CrawlProof user; stash the user id on the
// AuthInfo so tool handlers can scope to the caller. Returning undefined (with
// required:true) makes mcp-handler answer 401.
async function verifyToken(_req: Request, bearerToken?: string): Promise<AuthInfo | undefined> {
  if (!bearerToken) return undefined;
  if (bearerToken.startsWith(ACCESS_PREFIX)) {
    const grant = await resolveAccessToken(serviceClient(), bearerToken);
    if (!grant) return undefined;
    return { token: bearerToken, clientId: grant.userId, scopes: ["mcp"], extra: { userId: grant.userId, via: "oauth" } };
  }
  const auth = await authenticateToken(bearerToken);
  if (!auth.ok) return undefined;
  return {
    token: bearerToken,
    clientId: auth.userId,
    scopes: [],
    extra: { userId: auth.userId },
  };
}

// resourceUrl pins the resource_metadata origin to the public site, whatever
// Host the container sees. Built per request: siteOrigin() reads env at runtime.
const authHandler = (req: Request) =>
  withMcpAuth(handler, verifyToken, { required: true, resourceUrl: siteOrigin() })(req);

export { authHandler as GET, authHandler as POST, authHandler as DELETE };
