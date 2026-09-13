// OpenAffiliate tools for the CrawlProof MCP server: an agent's own link and
// ledger in our program, the directory of other merchants' programs, and
// joining one. Scoped to the authenticated user; the route uses the service
// client, so every lookup goes through the user's membership.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { serviceClient } from "@/lib/supabase/service";
import { ensureMembershipForUser, ledgerFor, profileUrlForMembership, setPayAddress } from "@/lib/affiliate/memberships";
import { addOrRefreshProgram, joinExternal, listDirectory, listJoins, syncJoin } from "@/lib/affiliate/directory";
import { requestPayout } from "@/lib/affiliate/payouts";
import { termsLine } from "@/lib/affiliate/program";
import { isPayAddress } from "@/lib/affiliate/spec";

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
async function userOf(userId: string) {
  const { data } = await serviceClient().from("profiles").select("email, display_name").eq("id", userId).maybeSingle();
  return { id: userId, email: (data?.email as string | null) ?? null, displayName: (data?.display_name as string | null) ?? null };
}

export function registerAffiliateTools(server: McpServer): void {
  server.registerTool(
    "affiliate_link",
    {
      description:
        "The caller's affiliate link, code and balances in the program CrawlProof runs (OpenAffiliate). Share the link; a purchase within 30 days of a click pays a commission after a 30-day hold, in USDC on Polygon.",
      inputSchema: {},
    },
    async (_args, extra) => {
      const m = await ensureMembershipForUser(await userOf(getUserId(extra)));
      if (!m) return textResult("The affiliate program is not available on this deployment.");
      const ledger = await ledgerFor(m);
      return textResult(
        [
          `link: ${ledger.link}`,
          `code: ${m.code}`,
          `profile: ${profileUrlForMembership(m)}`,
          `terms: ${termsLine()}`,
          `clicks: ${ledger.clicks.total} all time, ${ledger.clicks.window} in the window`,
          `balance: pending $${ledger.balance.pending.toFixed(2)}, approved $${ledger.balance.approved.toFixed(2)}, paid $${ledger.balance.paid.toFixed(2)}`,
          `payout address: ${m.payAddress ?? "not set (affiliate_set_payout_address)"}`,
        ].join("\n"),
      );
    },
  );

  server.registerTool(
    "affiliate_ledger",
    {
      description: "The caller's affiliate ledger: every conversion with status, hold and reason, and every payout with its tx. JSON, the same shape a third party reads with an oa_ token.",
      inputSchema: { since: z.string().optional().describe("ISO 8601; rows created or changed since") },
    },
    async (args, extra) => {
      const m = await ensureMembershipForUser(await userOf(getUserId(extra)));
      if (!m) return textResult("No membership.");
      const since = args.since ? new Date(args.since) : null;
      const ledger = await ledgerFor(m, since && !Number.isNaN(since.getTime()) ? since : null);
      return textResult(JSON.stringify(ledger, null, 2));
    },
  );

  server.registerTool(
    "affiliate_set_payout_address",
    {
      description: "Set the wallet the caller's affiliate commission is paid to (USDC on Polygon). An EVM address, 0x and 42 characters.",
      inputSchema: { address: z.string().describe("0x… address, or empty to clear") },
    },
    async (args, extra) => {
      const m = await ensureMembershipForUser(await userOf(getUserId(extra)));
      if (!m) return textResult("No membership.");
      const a = args.address.trim();
      if (a && !isPayAddress(a)) return textResult("That is not a wallet address. It starts with 0x and is 42 characters.");
      const out = await setPayAddress(m.id, a || null);
      return textResult(out.ok ? `Payout address ${a ? `set to ${a}` : "cleared"}.` : out.error);
    },
  );

  server.registerTool(
    "affiliate_payout",
    { description: "Send the caller's approved affiliate balance to their payout address now, if it is over the program minimum.", inputSchema: {} },
    async (_args, extra) => {
      const m = await ensureMembershipForUser(await userOf(getUserId(extra)));
      if (!m) return textResult("No membership.");
      const out = await requestPayout(m);
      return textResult(out.ok ? `Sent $${(out.amountCents / 100).toFixed(2)}${out.txHash ? ` (tx ${out.txHash})` : ` (${out.status})`}.` : out.error);
    },
  );

  server.registerTool(
    "affiliate_programs",
    {
      description: "The directory of other merchants' OpenAffiliate programs, each read from the merchant's own /.well-known/openaffiliate.json: what it pays, window, hold, payout, approval. Pass a url to read a new merchant first.",
      inputSchema: { url: z.string().optional().describe("A merchant URL to read and add before listing") },
    },
    async (args, extra) => {
      const userId = getUserId(extra);
      const notes: string[] = [];
      if (args.url) {
        const added = await addOrRefreshProgram(args.url, userId);
        notes.push(added.ok ? `Read ${added.row.origin}${added.warnings.length ? ` (${added.warnings.join("; ")})` : ""}.` : `Could not read ${args.url}: ${added.error}`);
      }
      const rows = await listDirectory();
      if (!rows.length) return textResult([...notes, "No merchants read yet."].join("\n"));
      const lines = rows.map((p) => {
        const pays = p.program.pays.map((x) => `${x.kind === "percent" ? `${x.value}%` : `$${x.value}`} per ${x.event}${x.months ? ` for ${x.months} months` : ""}`).join(", ");
        return `- ${p.merchant.name} (${p.origin}) program "${p.program.id}": ${pays}; window ${p.program.window ?? "unstated"} days; hold ${p.program.hold_days ?? "unstated"} days; payout ${p.program.payout?.methods.join("/") ?? "unstated"}; ${p.program.approval}; ${p.verified ? "verified" : "claimed"}`;
      });
      return textResult([...notes, ...lines].join("\n"));
    },
  );

  server.registerTool(
    "affiliate_join",
    {
      description: "Join another merchant's OpenAffiliate program as the caller, with the caller's CrawlProof profile and payout address. Returns the link to share and the join status.",
      inputSchema: {
        origin: z.string().describe("The merchant's URL or origin"),
        program: z.string().optional().describe("Program id when the merchant runs several"),
        code: z.string().optional().describe("Preferred code, 3 to 32 lower-case letters, digits or dashes"),
      },
    },
    async (args, extra) => {
      const out = await joinExternal(await userOf(getUserId(extra)), { origin: args.origin, programId: args.program, code: args.code });
      if (!out.ok) return textResult(out.error);
      const j = out.join;
      return textResult(`${out.existing ? "Already joined" : "Joined"} ${j.origin} program ${j.programId}: ${j.status}.${j.link ? ` Link: ${j.link}` : ""}`);
    },
  );

  server.registerTool(
    "affiliate_joined",
    {
      description: "The programs the caller has joined elsewhere, with each ledger's balances. Pass sync=true to re-read every ledger first.",
      inputSchema: { sync: z.boolean().optional() },
    },
    async (args, extra) => {
      const userId = getUserId(extra);
      if (args.sync) for (const j of await listJoins(userId)) await syncJoin(j.id, userId);
      const joins = await listJoins(userId);
      if (!joins.length) return textResult("No programs joined yet. Use affiliate_programs to find one and affiliate_join to join it.");
      return textResult(
        joins
          .map((j) => {
            const bal = (j.ledger?.balance ?? null) as { pending?: number; approved?: number; paid?: number } | null;
            return `- ${j.origin} ${j.programId}: ${j.status}${bal ? `; pending $${(bal.pending ?? 0).toFixed(2)}, approved $${(bal.approved ?? 0).toFixed(2)}, paid $${(bal.paid ?? 0).toFixed(2)}` : "; no ledger read"}${j.link ? `; link ${j.link}` : ""}${j.error ? `; ${j.error}` : ""}`;
          })
          .join("\n"),
      );
    },
  );
}
