// A human title and behaviour hints (MCP tool annotations) for every CrawlProof
// MCP tool. Connector directories, Claude's among them, require both on every
// tool, and a client uses the hints to decide what to confirm with the person.
//
// Rules: reads are readOnly and never destructive. Anything that deletes,
// overwrites, publishes or sends where it cannot be taken back (a social post,
// an email, an article) or spends money or credits is destructive. openWorld
// means the tool reaches outside CrawlProof's own data (a third-party site,
// a social network, a mailbox, an AI engine, a webhook receiver).
//
// withToolHints() is applied before any module registers, so a tool added
// without an entry here fails at startup instead of shipping unannotated.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

export interface ToolHints {
  title: string;
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export const TOOL_HINTS: Record<string, ToolHints> = {
  list_actors: { title: "List declared actors", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  add_actor: { title: "Add declared actor", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  mint_actor_token: { title: "Mint actor token", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  affiliate_link: { title: "Affiliate link and balances", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  affiliate_ledger: { title: "Affiliate ledger", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  affiliate_set_payout_address: { title: "Set affiliate payout address", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  affiliate_set_webhook: { title: "Set affiliate webhook", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  affiliate_token: { title: "Issue affiliate token", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  affiliate_payout: { title: "Pay out affiliate balance", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  affiliate_programs: { title: "Affiliate program directory", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  affiliate_join: { title: "Join affiliate program", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  affiliate_joined: { title: "Joined affiliate programs", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  start_audit: { title: "Start AEO audit", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  get_audit: { title: "Get audit result", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  autoblog_sites: { title: "List autoblog sites", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  autoblog_post: { title: "Queue autoblog article", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  autoblog_guest_post: { title: "Request guest post", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  autoblog_link_exchange: { title: "Find link-exchange matches", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  autoblog_articles: { title: "List autoblog articles", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  traffic: { title: "Site traffic", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  redeem_credit_code: { title: "Redeem credit code", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  list_invites: { title: "List invites", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  create_invite: { title: "Create invite", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  find_leads: { title: "Find leads", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  research_lead: { title: "Research lead", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  draft_message: { title: "Draft outreach message", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  send_message: { title: "Send outreach message", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  leads: { title: "Lead pipeline", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  suppress: { title: "Add to do-not-contact list", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  list_accounts: { title: "List social accounts", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  generate_promo_post: { title: "Generate promo post", readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  post_to_socials: { title: "Post to socials", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  promote_url: { title: "Promote URL on socials", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  promote_list_campaigns: { title: "List Promote campaigns", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  promote_add_keyword_source: { title: "Add keyword sources", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  promote_add_feed_source: { title: "Add feed source", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  promote_list_sources: { title: "List campaign sources", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  list_projects: { title: "List projects", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  recent_audits: { title: "Recent audits", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  ad_earnings: { title: "Ad earnings summary", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  promote_status: { title: "Promote post status", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  video_ad_funnel: { title: "Video ad funnel", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  list_trending_topics: { title: "Trending topics", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  list_webhooks: { title: "List webhooks", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  create_webhook: { title: "Create webhook", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  update_webhook: { title: "Update webhook", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  delete_webhook: { title: "Delete webhook", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  test_webhook: { title: "Send test webhook", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  rotate_webhook_secret: { title: "Rotate webhook secret", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  webhook_deliveries: { title: "Webhook deliveries", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  retry_webhook_delivery: { title: "Retry webhook delivery", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
};

/** Make every later registerTool call carry its title and annotations from TOOL_HINTS. */
export function withToolHints(server: McpServer): void {
  const register = server.registerTool.bind(server) as (name: string, config: Record<string, unknown>, cb: unknown) => unknown;
  (server as unknown as { registerTool: typeof register }).registerTool = (name, config, cb) => {
    const hints = TOOL_HINTS[name];
    if (!hints) throw new Error(`CrawlProof MCP tool ${name} has no title/annotations in lib/mcp/annotations.ts`);
    const { title, ...rest } = hints;
    const annotations: ToolAnnotations = { title, ...rest };
    return register(name, { ...config, title, annotations }, cb);
  };
}
