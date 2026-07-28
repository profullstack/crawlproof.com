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
          "No active social accounts connected. Connect some at https://crawlproof.com/promote/accounts",
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
          "No matching active accounts. Connect some at https://crawlproof.com/promote/accounts",
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
}
