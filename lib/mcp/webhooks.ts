// Webhooks for the CrawlProof MCP server: the same hub /api/v1/webhooks and
// the dashboard's Autoblog → Webhooks page use (lib/webhooks/hub.ts). An
// endpoint belongs to one autoblog site; `site` is its domain or id (optional
// when the caller has a single site).

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { WebhookError } from "@profullstack/webhooks";
import { serviceClient } from "@/lib/supabase/service";
import { getHooks } from "@/lib/webhooks/hub";
import { resolveOwnedSite } from "@/lib/webhooks/site";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getUserId(extra: any): string {
  const info = extra?.authInfo;
  const uid = info?.extra?.userId ?? info?.clientId;
  if (!uid || typeof uid !== "string") throw new Error("Unauthenticated.");
  return uid;
}

const json = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v, null, 2) }] });
const fail = (s: string) => ({ content: [{ type: "text" as const, text: s }], isError: true });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function withSite(extra: any, site: string | undefined, fn: (owner: string) => Promise<unknown>) {
  try {
    const r = await resolveOwnedSite(serviceClient(), getUserId(extra), site);
    if (!r.ok) return fail(r.error);
    return json(await fn(r.site.id));
  } catch (e) {
    if (e instanceof WebhookError) return fail(e.message);
    throw e;
  }
}

const site = z.string().optional().describe("Autoblog site domain or id; optional with a single site.");
const id = z.string().describe("Endpoint id (wh_…).");

export function registerWebhookTools(server: McpServer): void {
  server.registerTool(
    "list_webhooks",
    { description: "List a site's webhook endpoints and the event types CrawlProof emits (com.crawlproof.post.published.v1).", inputSchema: { site } },
    async (a, extra) => withSite(extra, a.site, async (o) => ({ endpoints: await getHooks().listEndpoints(o), event_types: getHooks().eventTypes })),
  );
  server.registerTool(
    "create_webhook",
    {
      description: "Add a webhook endpoint (https, public address) to a site. Returns the signing secret once; receivers verify Standard Webhooks signatures with it.",
      inputSchema: { site, url: z.string().url(), events: z.array(z.string()).optional(), description: z.string().optional() },
    },
    async (a, extra) => withSite(extra, a.site, (o) => getHooks().createEndpoint(o, { url: a.url, events: a.events, description: a.description })),
  );
  server.registerTool(
    "update_webhook",
    {
      description: "Change a webhook endpoint's url, events, description, or pause/resume it (enabled).",
      inputSchema: { site, id, url: z.string().url().optional(), events: z.array(z.string()).optional(), description: z.string().optional(), enabled: z.boolean().optional() },
    },
    async (a, extra) =>
      withSite(extra, a.site, (o) => getHooks().updateEndpoint(o, a.id, { url: a.url, events: a.events, description: a.description, enabled: a.enabled })),
  );
  server.registerTool(
    "delete_webhook",
    { description: "Remove a webhook endpoint.", inputSchema: { site, id } },
    async (a, extra) => withSite(extra, a.site, (o) => getHooks().deleteEndpoint(o, a.id)),
  );
  server.registerTool(
    "test_webhook",
    { description: "Send a webhook.test event to an endpoint now and report the HTTP result.", inputSchema: { site, id } },
    async (a, extra) => withSite(extra, a.site, (o) => getHooks().test(o, a.id)),
  );
  server.registerTool(
    "rotate_webhook_secret",
    { description: "Replace an endpoint's signing secret; the old one stops working at once. Returns the new secret.", inputSchema: { site, id } },
    async (a, extra) => withSite(extra, a.site, (o) => getHooks().rotateSecret(o, a.id)),
  );
  server.registerTool(
    "webhook_deliveries",
    { description: "Recent deliveries (status, attempts, HTTP code, error) for a site, or one endpoint.", inputSchema: { site, id: id.optional(), limit: z.number().int().min(1).max(200).optional() } },
    async (a, extra) =>
      withSite(extra, a.site, async (o) => ({
        deliveries: (await getHooks().deliveries(o, { endpointId: a.id, limit: a.limit ?? 25 })).map(({ payload: _p, ...d }) => d),
      })),
  );
  server.registerTool(
    "retry_webhook_delivery",
    { description: "Queue one delivery again from the start.", inputSchema: { site, delivery_id: z.string() } },
    async (a, extra) => withSite(extra, a.site, (o) => getHooks().redeliver(o, a.delivery_id)),
  );
}
