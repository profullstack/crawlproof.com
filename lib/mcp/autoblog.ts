// Autoblog capability for the CrawlProof MCP server. Lets an agent drive the
// link-exchange / autoblog engine that the dashboard drives by hand: list the
// caller's autoblog sites, queue an article on one, request a guest post from
// one site to another, find backlink-exchange candidates, and read a site's
// recent articles and its traffic.
//
// Every query is scoped EXPLICITLY to the authenticated user. The MCP route
// uses the service-role client (no RLS), so each tool filters by user_id /
// owner_id itself and verifies site ownership before any side effect. The lx
// HTTP routes authenticate with a Supabase session cookie, which an MCP caller
// does not have, so these tools call the lib functions directly rather than
// proxying the routes.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { serviceClient } from "@/lib/supabase/service";
import { enqueueArticleGenerate, enqueueGuestPostGenerate } from "@/lib/lx/workerClient";
import { findExchangeCandidates } from "@/lib/lx/exchangeMatcher";
import { projectStats, resolveProject } from "@/lib/tracker/apiStats";
import { trackerRange } from "@/lib/tracker/ranges";
import { DEFAULT_WHO, parseWho, whoToKind } from "@/lib/tracker/who";

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

type SiteRow = {
  id: string;
  domain: string | null;
  url: string | null;
  niche: string | null;
  status: string;
  backlinks_enabled: boolean;
};

/** The caller's autoblog site by id, or null if it is not theirs. */
async function ownedSite(userId: string, siteId: string): Promise<SiteRow | null> {
  const { data } = await serviceClient()
    .from("lx_site")
    .select("id, domain, url, niche, status, backlinks_enabled")
    .eq("id", siteId)
    .eq("user_id", userId)
    .maybeSingle();
  return (data as SiteRow | null) ?? null;
}

export function registerAutoblogTools(server: McpServer): void {
  server.registerTool(
    "autoblog_sites",
    {
      description:
        "List the caller's autoblog sites (id, domain, status, whether backlink exchange is on, and when the next article is due). Use a site id with autoblog_post, autoblog_guest_post, autoblog_link_exchange or autoblog_articles.",
      inputSchema: {},
    },
    async (_args, extra) => {
      const userId = getUserId(extra);
      const { data } = await serviceClient()
        .from("lx_site")
        .select("id, domain, url, status, backlinks_enabled, next_publish_at, daily_article_count")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(100);
      const rows =
        (data as {
          id: string;
          domain: string | null;
          url: string | null;
          status: string;
          backlinks_enabled: boolean;
          next_publish_at: string | null;
          daily_article_count: number | null;
        }[]) ?? [];
      if (!rows.length) return textResult("No autoblog sites. Set one up in the CrawlProof dashboard under Autoblog.");
      return textResult(
        rows
          .map(
            (s) =>
              `- ${s.domain ?? s.url ?? "(no domain)"} — ${s.status}, ${s.daily_article_count ?? 0}/day, exchange ${s.backlinks_enabled ? "on" : "off"}${s.next_publish_at ? `, next ${s.next_publish_at}` : ""} (id: ${s.id})`,
          )
          .join("\n"),
      );
    },
  );

  server.registerTool(
    "autoblog_post",
    {
      description:
        "Queue a new article for one of the caller's autoblog sites. The topic is chosen from the site's own keyword plan, exactly as a scheduled article. Returns once queued; the worker generates and delivers it. Credits are consumed and re-checked by the worker.",
      inputSchema: {
        siteId: z.string().describe("An autoblog site id from autoblog_sites."),
        preview: z.boolean().optional().describe("Generate a preview draft rather than a live post (default false)."),
      },
    },
    async (args, extra) => {
      const userId = getUserId(extra);
      const site = await ownedSite(userId, args.siteId);
      if (!site) return errorResult("No such autoblog site for this account.");
      if (site.status !== "active") return errorResult(`That site is ${site.status}; only an active site can post.`);
      await enqueueArticleGenerate(site.id, { manual: true, ...(args.preview ? { preview: true } : {}) });
      return textResult(`Queued an article for ${site.domain ?? site.url ?? site.id}. It will appear on the site's dashboard when generation lands.`);
    },
  );

  server.registerTool(
    "autoblog_guest_post",
    {
      description:
        "Request a guest post: one of the caller's sites (the author) writes an article for another site (the target), with a backlink to the author. The author site must be the caller's; the target is any site id in the network. Returns the request; the worker generates it.",
      inputSchema: {
        authorSiteId: z.string().describe("The caller's site that will author the post (from autoblog_sites)."),
        targetSiteId: z.string().describe("The site the guest post is written for. Must differ from the author."),
        topic: z.string().min(3).describe("What the guest post should be about."),
      },
    },
    async (args, extra) => {
      const userId = getUserId(extra);
      const author = await ownedSite(userId, args.authorSiteId);
      if (!author) return errorResult("No such author site for this account.");
      if (author.status !== "active") return errorResult(`The author site is ${author.status}; only an active site can author a guest post.`);
      if (args.targetSiteId === author.id) return errorResult("The target must differ from the author site.");
      const sb = serviceClient();
      const { data: target } = await sb.from("lx_site").select("id, status").eq("id", args.targetSiteId).maybeSingle();
      if (!target) return errorResult("No such target site.");

      // Dedupe on (author, target, topic), mirroring the dashboard route: a
      // generated one is reported, a failed one is retried, a live one is
      // returned rather than double-queued.
      const { data: existing } = await sb
        .from("lx_guest_post_request")
        .select("id, status")
        .eq("author_site_id", author.id)
        .eq("target_site_id", args.targetSiteId)
        .eq("topic", args.topic)
        .maybeSingle();
      if (existing) {
        if (existing.status === "generated") return textResult(`A guest post for this topic is already generated (request ${existing.id}).`);
        if (existing.status === "failed") {
          await sb.from("lx_guest_post_request").update({ status: "queued", error_text: null }).eq("id", existing.id);
          await enqueueGuestPostGenerate(author.id, args.targetSiteId, args.topic, { requestId: existing.id });
          return textResult(`Retried guest-post request ${existing.id}.`);
        }
        if (existing.status === "queued") await enqueueGuestPostGenerate(author.id, args.targetSiteId, args.topic, { requestId: existing.id });
        return textResult(`Guest-post request ${existing.id} is ${existing.status}.`);
      }
      const { data: inserted, error } = await sb
        .from("lx_guest_post_request")
        .insert({ author_site_id: author.id, target_site_id: args.targetSiteId, topic: args.topic, status: "queued" })
        .select("id")
        .single();
      if (error || !inserted) return errorResult(error?.message ?? "Could not record the guest-post request.");
      await enqueueGuestPostGenerate(author.id, args.targetSiteId, args.topic, { requestId: inserted.id });
      return textResult(`Queued a guest post from ${author.domain ?? author.id} to ${args.targetSiteId} (request ${inserted.id}).`);
    },
  );

  server.registerTool(
    "autoblog_link_exchange",
    {
      description:
        "Find reciprocal backlink-exchange candidates for one of the caller's sites: articles on other network sites, in a related niche, that could exchange links. Read-only; it proposes matches, it does not create links.",
      inputSchema: {
        siteId: z.string().describe("The caller's site to find exchange partners for."),
        keyword: z.string().optional().describe("A topic to match on; defaults to the site's niche."),
        slots: z.number().int().min(1).max(10).optional().describe("How many candidates to return (default 3)."),
      },
    },
    async (args, extra) => {
      const userId = getUserId(extra);
      const site = await ownedSite(userId, args.siteId);
      if (!site) return errorResult("No such autoblog site for this account.");
      const result = await findExchangeCandidates(serviceClient(), {
        selfSiteId: site.id,
        selfNiche: site.niche,
        keyword: (args.keyword ?? site.niche ?? "").trim(),
        slots: args.slots ?? 3,
      });
      if (!result.candidates.length) {
        return textResult(`No exchange candidates${result.networkSize ? ` (network has ${result.networkSize} eligible articles)` : ""}. Backlink exchange must be enabled on both sites.`);
      }
      return textResult(
        `${result.candidates.length} candidate${result.candidates.length === 1 ? "" : "s"}${result.relaxed ? " (relaxed niche match)" : ""}:\n` +
          result.candidates
            .map((c) => `- "${c.title}" — ${c.url}`)
            .join("\n"),
      );
    },
  );

  server.registerTool(
    "autoblog_articles",
    {
      description: "List recent articles on one of the caller's autoblog sites, with their status and slug.",
      inputSchema: {
        siteId: z.string().describe("An autoblog site id from autoblog_sites."),
        limit: z.number().int().min(1).max(50).optional().describe("Max rows (default 10)."),
      },
    },
    async (args, extra) => {
      const userId = getUserId(extra);
      const site = await ownedSite(userId, args.siteId);
      if (!site) return errorResult("No such autoblog site for this account.");
      const { data } = await serviceClient()
        .from("lx_article")
        .select("title, slug, status, published_at")
        .eq("site_id", site.id)
        .order("created_at", { ascending: false })
        .limit(args.limit ?? 10);
      const rows = (data as { title: string; slug: string; status: string; published_at: string | null }[]) ?? [];
      if (!rows.length) return textResult("No articles yet on that site.");
      return textResult(rows.map((a) => `- [${a.status}] ${a.title} (${a.slug})${a.published_at ? ` — ${a.published_at}` : ""}`).join("\n"));
    },
  );

  server.registerTool(
    "traffic",
    {
      description:
        "A site's traffic over a range: visitors, pageviews, and top sources and pages. The same data the dashboard shows, scoped to the caller. `who` filters humans, bots or all.",
      inputSchema: {
        site: z.string().optional().describe("Site hostname, id or name. Omit to use the caller's only/first site."),
        range: z.string().optional().describe("A window like 1h, 24h, 7d, 30d (default 24h)."),
        who: z.enum(["humans", "bots", "all"]).optional().describe("Which visitors to count (default humans)."),
      },
    },
    async (args, extra) => {
      const userId = getUserId(extra);
      const who = args.who ? parseWho(args.who) : DEFAULT_WHO;
      if (!who) return errorResult("Unknown who. Expected humans, bots or all.");
      const sb = serviceClient();
      const resolved = await resolveProject(sb, userId, args.site ?? null);
      if (!resolved.ok) return errorResult(resolved.error);
      const range = trackerRange(args.range ?? null);
      const stats = await projectStats(sb, resolved.project, range, whoToKind(who), who, false);
      const topSources = stats.sources.slice(0, 5).map((s) => `  ${s.label}: ${s.value}`).join("\n");
      const topPages = stats.pages.slice(0, 5).map((p) => `  ${p.label}: ${p.value}`).join("\n");
      return textResult(
        `${stats.project.name} — ${stats.range}, ${who}\n` +
          `visitors ${stats.totals.visitors}, pageviews ${stats.totals.pageviews}\n` +
          (topSources ? `top sources:\n${topSources}\n` : "") +
          (topPages ? `top pages:\n${topPages}` : ""),
      );
    },
  );
}
