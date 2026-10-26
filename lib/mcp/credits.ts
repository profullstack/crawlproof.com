// Credit codes and invites for the CrawlProof MCP server: redeem a code someone
// handed you, and see or create your scarce invites. Scoped to the caller.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { env } from "@/lib/env";
import {
  INVITE_BONUS_CREDITS,
  InviteError,
  createInvite,
  inviteOverview,
  inviteUrl,
  redeemCreditCode,
  settleInvitesSentBy,
} from "@/lib/creditCodes";

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

export function registerCreditTools(server: McpServer): void {
  server.registerTool(
    "redeem_credit_code",
    {
      description:
        "Redeem a CrawlProof credit code (CR-XXXX-XXXX-XXXX-XXXX) for scan credits on the caller's account. Each code works once per account.",
      inputSchema: { code: z.string().describe("The credit code, any case, dashes optional.") },
    },
    async (args, extra) => {
      const r = await redeemCreditCode(getUserId(extra), args.code);
      if (!r.ok) return textResult(`Not redeemed (${r.reason}): ${r.message}`);
      return textResult(`Redeemed: +${r.credits} credits. Balance: ${r.balance ?? "?"} credits.`);
    },
  );

  server.registerTool(
    "list_invites",
    {
      description: `The caller's scarce invites (3 per account), how many are left, and whether each used invite's bonus (${INVITE_BONUS_CREDITS} credits each side) has been paid.`,
      inputSchema: {},
    },
    async (_args, extra) => {
      const userId = getUserId(extra);
      await settleInvitesSentBy(userId).catch(() => null);
      const o = await inviteOverview(userId);
      const lines = [
        `${o.quota.left} of ${o.quota.total} invites left${o.canInvite ? "" : ` (locked: ${o.blockedReason ?? `unlocks ${o.unlocksAt}`})`}`,
        ...o.invites.map(
          (i) =>
            `- ${i.id} ${i.status}${i.status === "used" ? ` -> ${i.usedByEmail ?? "someone"}, bonus ${i.bonus}` : ""}${i.note ? ` "${i.note}"` : ""}`,
        ),
      ];
      return textResult(lines.join("\n"));
    },
  );

  server.registerTool(
    "create_invite",
    {
      description:
        "Create one of the caller's scarce invites and return its link (shown once). A new account that joins on it and confirms its email earns both sides bonus scan credits.",
      inputSchema: { note: z.string().optional().describe("Who it is for; only the caller sees it.") },
    },
    async (args, extra) => {
      try {
        const inv = await createInvite(getUserId(extra), args.note ?? "");
        return textResult(`${inviteUrl(env.siteUrl, inv.code)}\ncode ${inv.code} (shown once, expires ${inv.expiresAt ? new Date(inv.expiresAt).toISOString().slice(0, 10) : "never"})`);
      } catch (err) {
        if (err instanceof InviteError) return textResult(`Error: ${err.message}`);
        throw err;
      }
    },
  );
}
