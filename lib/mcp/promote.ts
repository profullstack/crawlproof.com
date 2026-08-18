// Promote capability for the CrawlProof MCP server. Registers tools that let an
// agent write on-brand promo posts for a URL and publish them to the caller's
// connected social accounts — reusing the same generatePitch + postViaAccount
// pipeline as the in-app Promote feature. Auth (the crp_ user) is resolved by
// the /api/mcp route's withMcpAuth verifier and arrives on extra.authInfo.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { z } from "zod";
import { env } from "@/lib/env";
import { serviceClient } from "@/lib/supabase/service";
import { generatePitch, fetchLinkTitle } from "@/lib/promote/generatePitch";
import { postViaAccount, type PostResult } from "@/lib/sp/post";
import { parseKeywords, topicPageUrl } from "@/lib/promote/keywords";
import {
  addKeywordSources,
  ensureFeed,
  normalizeFeedUrl,
  validateFeedUrl,
} from "@/lib/promote/sources";
import { fanOutToSubscribers, ingestFeedNow } from "@/lib/promote/ingest";

type Account = { id: string; platform: string; handle: string; status: string };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getUserId(extra: any): string {
  const info = extra?.authInfo;
  const uid = info?.extra?.userId ?? info?.clientId;
  if (!uid || typeof uid !== "string") throw new Error("Unauthenticated.");
  return uid;
}

function textResult(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}
function errorResult(s: string) {
  return { content: [{ type: "text" as const, text: s }], isError: true };
}

function aiClients() {
  return {
    anthropic: env.anthropicApiKey ? new Anthropic({ apiKey: env.anthropicApiKey }) : null,
    openai: env.openaiApiKey ? new OpenAI({ apiKey: env.openaiApiKey }) : null,
  };
}

async function activeAccounts(userId: string, ids?: string[]): Promise<Account[]> {
  const sb = serviceClient();
  let q = sb
    .from("sp_account")
    .select("id, platform, handle, status")
    .eq("user_id", userId)
    .eq("status", "active");
  if (ids && ids.length) q = q.in("id", ids);
  const { data } = await q;
  return (data as Account[]) ?? [];
}

function formatPost(a: Account, r: PostResult): string {
  if (!r.ok) return `✗ ${a.platform} (${a.handle}): ${r.error}`;
  if (r.pending)
    return `⏳ ${a.platform} (${a.handle}): queued — publishes shortly (browser-auth platform).`;
  return `✓ ${a.platform} (${a.handle}): posted${r.webUrl ? ` → ${r.webUrl}` : ""}`;
}

export function registerPromoteTools(server: McpServer): void {
  server.registerTool(
    "list_accounts",
    {
      description:
        "List the caller's connected social accounts (platform, handle, id). Use the ids with post_to_socials or promote_url.",
      inputSchema: {},
    },
    async (_args, extra) => {
      const userId = getUserId(extra);
      const accts = await activeAccounts(userId);
      if (!accts.length)
        return textResult(
          "No active social accounts connected. Connect some at https://crawlproof.com/dashboard/promote/accounts",
        );
      return textResult(accts.map((a) => `- ${a.platform}: ${a.handle} (id: ${a.id})`).join("\n"));
    },
  );

  server.registerTool(
    "generate_promo_post",
    {
      description:
        "Write an AI promo post for a URL in the brand's voice. Does NOT publish it — returns the text so you can preview or edit. Optionally target a platform for tone/length.",
      inputSchema: {
        url: z.string().describe("The page/product URL to promote."),
        platform: z
          .string()
          .optional()
          .describe("Target platform (reddit, bluesky, mastodon, x, …) for tone/length."),
        angle: z.string().optional().describe("Optional hook/angle to emphasize."),
        brand_voice: z.string().optional().describe("Optional brand-voice guidance."),
      },
    },
    async (args, _extra) => {
      const { anthropic, openai } = aiClients();
      if (!anthropic && !openai)
        return errorResult("No AI provider configured on the server.");
      const title = await fetchLinkTitle(args.url).catch(() => null);
      const pitch = await generatePitch({
        url: args.url,
        title,
        angle: args.angle ?? null,
        platform: args.platform ?? "generic",
        brandVoice: args.brand_voice ?? null,
        recentBodies: [],
        anthropic,
        openai,
      });
      return textResult(pitch.body);
    },
  );

  server.registerTool(
    "post_to_socials",
    {
      description:
        "Publish the given text to the caller's connected accounts. Pass account_ids to target specific ones, or omit to post to all active accounts. Cookie-auth platforms return 'queued'.",
      inputSchema: {
        text: z.string().describe("The exact post text to publish."),
        account_ids: z
          .array(z.string())
          .optional()
          .describe("Account ids to post to (from list_accounts). Omit for all active accounts."),
      },
    },
    async (args, extra) => {
      const userId = getUserId(extra);
      const accts = await activeAccounts(userId, args.account_ids);
      if (!accts.length) return errorResult("No matching active accounts.");
      const sb = serviceClient();
      const lines: string[] = [];
      for (const a of accts) {
        const r = await postViaAccount({
          supabase: sb,
          userId,
          input: { accountId: a.id, text: args.text },
          source: "api",
        });
        lines.push(formatPost(a, r));
      }
      return textResult(lines.join("\n"));
    },
  );

  server.registerTool(
    "promote_url",
    {
      description:
        "One shot: write an on-brand promo post for a URL and publish it to the caller's socials, generating a per-platform variant for each target account. Pass account_ids to target specific ones, or omit for all active accounts.",
      inputSchema: {
        url: z.string().describe("The page/product URL to promote."),
        account_ids: z
          .array(z.string())
          .optional()
          .describe("Account ids to post to. Omit for all active accounts."),
        angle: z.string().optional().describe("Optional hook/angle to emphasize."),
        brand_voice: z.string().optional().describe("Optional brand-voice guidance."),
      },
    },
    async (args, extra) => {
      const userId = getUserId(extra);
      const accts = await activeAccounts(userId, args.account_ids);
      if (!accts.length)
        return errorResult(
          "No matching active accounts. Connect some at https://crawlproof.com/dashboard/promote/accounts",
        );
      const { anthropic, openai } = aiClients();
      if (!anthropic && !openai) return errorResult("No AI provider configured on the server.");
      const title = await fetchLinkTitle(args.url).catch(() => null);
      const sb = serviceClient();
      const lines: string[] = [];
      for (const a of accts) {
        try {
          const pitch = await generatePitch({
            url: args.url,
            title,
            angle: args.angle ?? null,
            platform: a.platform,
            brandVoice: args.brand_voice ?? null,
            recentBodies: [],
            anthropic,
            openai,
          });
          const r = await postViaAccount({
            supabase: sb,
            userId,
            input: { accountId: a.id, text: pitch.body, title: pitch.title },
            source: "api",
          });
          lines.push(formatPost(a, r));
        } catch (e) {
          lines.push(`✗ ${a.platform} (${a.handle}): ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      return textResult(lines.join("\n"));
    },
  );

  // ---- Content sources -------------------------------------------------
  // Same service layer the dashboard uses, so a campaign built by an agent is
  // indistinguishable from one built in the UI.

  server.registerTool(
    "promote_list_campaigns",
    {
      description:
        "List the caller's Promote campaigns with their ids, status and content mix. Use an id with the source tools.",
      inputSchema: {},
    },
    async (_args, extra) => {
      const userId = getUserId(extra);
      const sb = serviceClient();
      const { data } = await sb
        .from("promo_list")
        .select("id, name, status, cadence_seconds, source_mix")
        .eq("user_id", userId)
        .order("created_at", { ascending: false });
      const rows = (data ?? []) as Array<Record<string, any>>;
      if (!rows.length) return textResult("No Promote campaigns yet.");
      return textResult(
        rows
          .map((r) => {
            const mix = r.source_mix ?? {};
            return `${r.id}  ${r.name} [${r.status}] every ${Math.round((r.cadence_seconds ?? 0) / 60)}m  mix owned=${mix.owned ?? 0}/partner=${mix.partner ?? 0}/shared=${mix.shared ?? 0}`;
          })
          .join("\n"),
      );
    },
  );

  server.registerTool(
    "promote_add_keyword_source",
    {
      description:
        "Add one RSS Amplifier topic source per keyword to a Promote campaign. 'bitcoin, ethereum' creates two independent sources, never one combined feed. Reports each keyword individually.",
      inputSchema: {
        campaign_id: z.string().describe("Promote campaign id (from promote_list_campaigns)."),
        keywords: z
          .string()
          .describe("One keyword, or several separated by commas. Phrases are one keyword."),
        ownership: z
          .enum(["owned", "partner", "shared"])
          .optional()
          .describe("Defaults to 'shared' — topic feeds are other people's writing."),
      },
    },
    async (args, extra) => {
      const userId = getUserId(extra);
      const sb = serviceClient();
      const { data: list } = await sb
        .from("promo_list")
        .select("id")
        .eq("id", args.campaign_id)
        .eq("user_id", userId)
        .maybeSingle();
      if (!list) return errorResult("Campaign not found.");

      const keywords = parseKeywords(args.keywords);
      if (!keywords.length) return errorResult("No usable keywords in that input.");

      const results = await addKeywordSources(sb, {
        listId: args.campaign_id,
        keywords,
        ownership: args.ownership ?? "shared",
      });

      for (const r of results) {
        if (!r.ok || !r.feedId) continue;
        try {
          await ingestFeedNow(sb, r.feedId);
          await fanOutToSubscribers(sb, r.feedId, new Date(), r.sourceId);
        } catch {
          // The worker retries; adding the source still succeeded.
        }
      }

      return textResult(
        results
          .map((r) =>
            r.ok
              ? `✓ ${r.keyword} → ${topicPageUrl(r.slug)}`
              : `✗ ${r.keyword}: ${r.error}`,
          )
          .join("\n"),
      );
    },
  );

  server.registerTool(
    "promote_add_feed_source",
    {
      description:
        "Add an RSS or Atom feed as a content source for a Promote campaign. The feed is fetched and validated before it is saved.",
      inputSchema: {
        campaign_id: z.string().describe("Promote campaign id."),
        feed_url: z.string().describe("The RSS or Atom feed URL."),
        ownership: z
          .enum(["owned", "partner", "shared"])
          .optional()
          .describe("Defaults to 'owned' — a feed you added deliberately is usually yours."),
        label: z.string().optional().describe("Display name; defaults to the feed's own title."),
      },
    },
    async (args, extra) => {
      const userId = getUserId(extra);
      const sb = serviceClient();
      const { data: list } = await sb
        .from("promo_list")
        .select("id")
        .eq("id", args.campaign_id)
        .eq("user_id", userId)
        .maybeSingle();
      if (!list) return errorResult("Campaign not found.");

      const normalized = normalizeFeedUrl(args.feed_url);
      if (!normalized.ok) return errorResult(normalized.error);
      const validation = await validateFeedUrl(normalized.url);
      if (!validation.ok) return errorResult(validation.error);

      const feed = await ensureFeed(sb, {
        feedUrl: validation.feedUrl,
        kind: "custom_feed",
        title: validation.title,
      });
      if (!feed) return errorResult("Could not register that feed.");

      const { data: source, error } = await sb
        .from("promo_source")
        .insert({
          list_id: args.campaign_id,
          feed_id: feed.id,
          type: "custom_feed",
          ownership: args.ownership ?? "owned",
          label: (args.label ?? "").trim() || validation.title || validation.feedUrl,
        })
        .select("id")
        .single();
      if (error || !source)
        return errorResult("This campaign already tracks that feed.");

      try {
        await ingestFeedNow(sb, feed.id);
        await fanOutToSubscribers(sb, feed.id, new Date(), source.id as string);
      } catch {
        // Ingestion retries on the worker's schedule.
      }

      return textResult(
        `✓ Added ${validation.title ?? validation.feedUrl} (${validation.itemCount} entries) as a ${args.ownership ?? "owned"} source.`,
      );
    },
  );

  server.registerTool(
    "promote_list_sources",
    {
      description:
        "List the content sources of a Promote campaign, with ownership, health and how many links each has contributed.",
      inputSchema: { campaign_id: z.string().describe("Promote campaign id.") },
    },
    async (args, extra) => {
      const userId = getUserId(extra);
      const sb = serviceClient();
      const { data: list } = await sb
        .from("promo_list")
        .select("id")
        .eq("id", args.campaign_id)
        .eq("user_id", userId)
        .maybeSingle();
      if (!list) return errorResult("Campaign not found.");

      const { data } = await sb
        .from("promo_source")
        .select(
          "id, type, ownership, label, enabled, items_imported, last_ingested_at, promo_feed(feed_url, last_success_at, consecutive_failures, last_error)",
        )
        .eq("list_id", args.campaign_id)
        .order("created_at", { ascending: true });

      const rows = (data ?? []) as Array<Record<string, any>>;
      if (!rows.length) return textResult("This campaign has no content sources yet.");

      return textResult(
        rows
          .map((r) => {
            const feed = r.promo_feed ?? {};
            const health =
              (feed.consecutive_failures ?? 0) > 0
                ? `failing (${feed.last_error ?? "unknown error"})`
                : "ok";
            return `${r.id}  ${r.label} [${r.type}/${r.ownership}]${r.enabled ? "" : " (paused)"}  imported=${r.items_imported ?? 0}  ${health}`;
          })
          .join("\n"),
      );
    },
  );

}
