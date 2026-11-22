// Buyer Intent tools for the CrawlProof MCP server. Scoped to the caller.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  IntentError,
  createWatch,
  draftLeadReply,
  listLeads,
  listWatches,
  publicWatch,
  runWatchNow,
  setLeadStatus,
} from "@/lib/intent/store";
import { INTENT_SWEEP_CREDITS, REPLY_DRAFT_CREDITS, SOURCE_IDS, TIER_LABELS } from "@/lib/intent/tiers";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getUserId(extra: any): string {
  const info = extra?.authInfo;
  const uid = info?.extra?.userId ?? info?.clientId;
  if (!uid || typeof uid !== "string") throw new Error("Unauthenticated.");
  return uid;
}
function text(s: unknown) {
  return { content: [{ type: "text" as const, text: typeof s === "string" ? s : JSON.stringify(s, null, 2) }] };
}
async function guard(fn: () => Promise<unknown>) {
  try {
    return text(await fn());
  } catch (err) {
    return text(`Error: ${err instanceof IntentError || err instanceof Error ? err.message : String(err)}`);
  }
}

export function registerIntentTools(server: McpServer): void {
  server.registerTool(
    "list_intent_watches",
    {
      description: "The caller's Buyer Intent watches: the keywords and competitors CrawlProof searches public communities for, on a schedule.",
      inputSchema: {},
    },
    async (_a, extra) => guard(async () => (await listWatches(getUserId(extra))).map((w) => publicWatch(w))),
  );

  server.registerTool(
    "create_intent_watch",
    {
      description: `Create a Buyer Intent watch and run its first sweep (${INTENT_SWEEP_CREDITS} credits a sweep, trial credits first). Finds people on Reddit, Hacker News, Stack Exchange, X, LinkedIn, review sites and more asking for what you sell.`,
      inputSchema: {
        name: z.string().describe("Product or brand name."),
        keywords: z.array(z.string()).optional().describe("Phrases a buyer would use."),
        competitors: z.array(z.string()).optional().describe("Competitor names to catch 'alternative to' and switching threads."),
        sells: z.string().optional().describe("One sentence on what you sell; lets the model catch buyers who never use your keywords."),
        sources: z.array(z.enum(SOURCE_IDS as [string, ...string[]])).optional(),
        cadence: z.enum(["daily", "4h", "hourly"]).optional(),
        min_score: z.number().int().min(0).max(100).optional(),
      },
    },
    async (args, extra) =>
      guard(async () => {
        const owner = getUserId(extra);
        const w = await createWatch(owner, args);
        const r = await runWatchNow(owner, w.id);
        return { watch: publicWatch(w), first_sweep: r };
      }),
  );

  server.registerTool(
    "run_intent_watch",
    {
      description: `Sweep one watch now (${INTENT_SWEEP_CREDITS} credits).`,
      inputSchema: { watch_id: z.string() },
    },
    async (args, extra) => guard(() => runWatchNow(getUserId(extra), args.watch_id)),
  );

  server.registerTool(
    "list_intent_leads",
    {
      description: `Buyer-intent leads, newest and strongest first. Tiers: hot (${TIER_LABELS.hot}), engage (${TIER_LABELS.engage}), monitor (${TIER_LABELS.monitor}). Dismissed leads are hidden unless status=dismissed.`,
      inputSchema: {
        watch_id: z.string().optional(),
        tier: z.enum(["hot", "engage", "monitor"]).optional(),
        status: z.enum(["new", "replied", "dismissed"]).optional(),
        limit: z.number().int().min(1).max(500).optional(),
      },
    },
    async (args, extra) =>
      guard(() => listLeads(getUserId(extra), { watchId: args.watch_id, tier: args.tier, status: args.status, limit: args.limit ?? 50 })),
  );

  server.registerTool(
    "draft_intent_reply",
    {
      description: `Draft a reply to one lead for the user to post themselves (${REPLY_DRAFT_CREDITS} credit; a stored draft is returned free). CrawlProof never posts for you.`,
      inputSchema: { lead_id: z.string(), regenerate: z.boolean().optional() },
    },
    async (args, extra) => guard(() => draftLeadReply(getUserId(extra), args.lead_id, args.regenerate ?? false)),
  );

  server.registerTool(
    "set_intent_lead_status",
    {
      description: "Mark a lead replied, dismissed, or back to new.",
      inputSchema: { lead_id: z.string(), status: z.enum(["new", "replied", "dismissed"]) },
    },
    async (args, extra) => guard(() => setLeadStatus(getUserId(extra), args.lead_id, args.status)),
  );
}
