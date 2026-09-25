// Read-only "stats" capability for the CrawlProof MCP server. Lets an agent ask
// "what sites do I have / how did my last audits score / what am I earning /
// did my promo posts land" without any side effects. Everything is scoped
// EXPLICITLY to the authenticated user — the MCP route uses the service-role
// client (no RLS), so every query filters by owner_id/user_id itself.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { serviceClient } from "@/lib/supabase/service";
import { videoFunnelForOwner, videoSlotFunnelForOwner } from "@/lib/ads/video/stats";

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
function dollars(cents: number): string {
  const neg = cents < 0;
  return `${neg ? "-" : ""}$${(Math.abs(cents) / 100).toFixed(2)}`;
}

export function registerStatsTools(server: McpServer): void {
  server.registerTool(
    "list_projects",
    {
      description: "List the caller's sites/projects (name, url, id). Use an id/url with recent_audits.",
      inputSchema: {},
    },
    async (_args, extra) => {
      const userId = getUserId(extra);
      const { data } = await serviceClient()
        .from("projects")
        .select("id, name, url")
        .eq("owner_id", userId)
        .order("created_at", { ascending: false })
        .limit(100);
      const rows = (data as { id: string; name: string; url: string }[]) ?? [];
      if (!rows.length) return textResult("No projects yet.");
      return textResult(rows.map((p) => `- ${p.name} — ${p.url} (id: ${p.id})`).join("\n"));
    },
  );

  server.registerTool(
    "recent_audits",
    {
      description:
        "The caller's recent AEO audits with their scores (0–100) and status. Optionally filter by a URL substring.",
      inputSchema: {
        url: z.string().optional().describe("Filter to audits whose target URL contains this."),
        limit: z.number().int().min(1).max(50).optional().describe("Max rows (default 10)."),
      },
    },
    async (args, extra) => {
      const userId = getUserId(extra);
      let q = serviceClient()
        .from("audits")
        .select("target_url, engine, score, status, created_at")
        .eq("owner_id", userId)
        .order("created_at", { ascending: false })
        .limit(args.limit ?? 10);
      if (args.url) q = q.ilike("target_url", `%${args.url}%`);
      const { data } = await q;
      const rows =
        (data as { target_url: string; engine: string | null; score: number | null; status: string; created_at: string }[]) ??
        [];
      if (!rows.length) return textResult("No audits found.");
      return textResult(
        rows
          .map(
            (a) =>
              `- ${a.target_url} [${a.engine ?? "?"}] ${a.score ?? "—"}/100 (${a.status}) — ${new Date(
                a.created_at,
              )
                .toISOString()
                .slice(0, 10)}`,
          )
          .join("\n"),
      );
    },
  );

  server.registerTool(
    "ad_earnings",
    {
      description:
        "The caller's ad-network money summary: earned as a publisher, spent as an advertiser, and the net.",
      inputSchema: {},
    },
    async (_args, extra) => {
      const userId = getUserId(extra);
      const sb = serviceClient();
      const [{ data: ledger }, { data: campaigns }] = await Promise.all([
        sb.from("ad_ledger").select("amount_cents").eq("owner_id", userId).eq("kind", "publisher_accrual"),
        sb.from("ad_campaigns").select("total_spent_cents").eq("owner_id", userId),
      ]);
      const earned = ((ledger as { amount_cents: number | null }[]) ?? []).reduce(
        (a, r) => a + (r.amount_cents ?? 0),
        0,
      );
      const spent = ((campaigns as { total_spent_cents: number | null }[]) ?? []).reduce(
        (a, r) => a + (r.total_spent_cents ?? 0),
        0,
      );
      return textResult(
        `Earned (publisher): ${dollars(earned)}\nSpent (advertiser): ${dollars(spent)}\nNet: ${dollars(
          earned - spent,
        )}`,
      );
    },
  );

  server.registerTool(
    "promote_status",
    {
      description:
        "The caller's recent Promote posts and their status (posted / queued / failed) across connected socials.",
      inputSchema: { limit: z.number().int().min(1).max(50).optional().describe("Max rows (default 15).") },
    },
    async (args, extra) => {
      const userId = getUserId(extra);
      const sb = serviceClient();
      const { data: lists } = await sb.from("promo_list").select("id").eq("user_id", userId);
      const ids = ((lists as { id: string }[]) ?? []).map((l) => l.id);
      if (!ids.length) return textResult("No Promote lists yet.");
      const { data } = await sb
        .from("promo_post")
        .select("platform, status, post_url, created_at")
        .in("list_id", ids)
        .order("created_at", { ascending: false })
        .limit(args.limit ?? 15);
      const rows =
        (data as { platform: string; status: string; post_url: string | null; created_at: string }[]) ?? [];
      if (!rows.length) return textResult("No posts yet.");
      const counts: Record<string, number> = {};
      for (const r of rows) {
        const s = r.status === "pending" ? "queued" : r.status;
        counts[s] = (counts[s] ?? 0) + 1;
      }
      const summary = Object.entries(counts)
        .map(([k, v]) => `${k}: ${v}`)
        .join(", ");
      const lines = rows.map((r) => {
        const status = r.status === "pending" ? "queued" : r.status;
        return `- ${r.platform}: ${status}${r.post_url ? ` → ${r.post_url}` : ""}`;
      });
      return textResult(`Last ${rows.length} (${summary}):\n${lines.join("\n")}`);
    },
  );

  server.registerTool(
    "video_ad_funnel",
    {
      description:
        "Pre-roll video ad playback funnel for the caller: breaks filled, breaks that started playing, quartiles, completions, errors. A fill is an ad that was chosen, a start is one that actually played — they are different numbers and the gap between them is ads nobody saw.",
      inputSchema: { days: z.number().int().min(1).max(365).optional() },
    },
    async (args, extra) => {
      const userId = getUserId(extra);
      const days = args.days ?? 7;
      const sb = serviceClient();
      const campaigns = await videoFunnelForOwner(sb, userId, days);
      const slots = await videoSlotFunnelForOwner(sb, userId, days);
      if (!campaigns.length && !slots.length) {
        return textResult(`No video breaks in the last ${days} day(s).`);
      }
      const pct = (v: number) => `${Math.round(v * 100)}%`;
      const lines: string[] = [];
      if (campaigns.length) {
        lines.push("Campaigns:");
        for (const c of campaigns) {
          lines.push(
            `- ${c.campaignName} (${c.placement === "in_banner" ? "in-banner" : "pre-roll"}): ${c.fills} filled, ${c.starts} started (${pct(c.startRate)}), ` +
              `${c.completes} completed (${pct(c.completionRate)} of starts), ${c.clicks} click(s), ${c.errors} error(s)`,
          );
        }
      }
      if (slots.length) {
        lines.push("Slots:");
        for (const s of slots) {
          lines.push(
            `- ${s.projectName || s.slotId} (${s.placement === "in_banner" ? "in-banner" : "pre-roll"}): ${s.fills} filled (${s.houseFills} house, ${s.unfilled} empty), ` +
              `${s.starts} started, ${s.completes} completed`,
          );
        }
      }
      const silent = [...campaigns, ...slots].filter((r) => r.fills > 0 && r.starts === 0);
      if (silent.length) {
        lines.push(
          `${silent.length} row(s) filled a break and reported no start — the player is not sending playback events (crawlproof.com/preroll.js does it for you).`,
        );
      }
      return textResult(lines.join("\n"));
    },
  );
}
