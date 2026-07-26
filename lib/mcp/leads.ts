// Leads: one toolset for finding businesses, researching them, and reaching
// out — by email or on Reddit.
//
// This replaces two separate toolsets that had grown sixteen tools between
// them, most of which differed only by channel. An agent picking between
// `send_outreach` and `reddit_send` is answering a question the tool should
// answer for itself, so the channel is a parameter now, not a tool.
//
// Seven tools:
//
//   find_leads      businesses by search query, or Reddit threads by keyword
//   research_lead   scan the site, price the fix, find the contact address
//   draft_message   write it, grounded in the scan or in what they asked
//   send_message    the only thing that touches the outside world
//   campaign        create / update / run the autopilot
//   leads           list, filter, export
//   suppress        do-not-contact, any channel
//
// What makes the output different from a prompt wrapper: CrawlProof runs the
// scanner, so a cold email opens with a defect that is verifiably on their
// site, linked to a report they can check.
//
// Leads belong to a project — the same agency runs different outreach for
// different clients — so every tool takes an optional `project` (id, name or
// site URL) and defaults to the only project when there is just one.
//
// Auth: the crp_ bearer token resolved by app/api/mcp/route.ts.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { env } from "@/lib/env";
import { serviceClient } from "@/lib/supabase/service";
import { hostOf } from "@/lib/audit/share-card";
import { isThirdPartyHost } from "@/lib/leadCampaign";
import { nextStepReadyAt, normalizeHost, type OutreachStep } from "@/lib/outreach/cold";
import {
  draftEmail,
  factsOf,
  isWeakEnough,
  loadProspect,
  researchProspect,
  sendProspectEmail,
  siteBase,
} from "@/lib/outreach/pipeline";
import { addSuppression, isEmailSuppressed, sendsInLast24h } from "@/lib/outreach/suppress";
import { discoverProspects } from "@/lib/outreach/discover";
import { enrichContact, findEmail, leadsToCsv, leadsToJson, type ExportableLead } from "@/lib/outreach/enrich";
import { CAMPAIGN_COLUMNS, runEmailCampaignTick, summarize, type CampaignRow } from "@/lib/outreach/runner";
import {
  draftRedditReply,
  findRedditThreads,
  sendRedditOutreach,
} from "@/lib/outreach/redditPipeline";

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

/**
 * Leads belong to a project, so every tool needs one. Accepts a project id,
 * name, or site URL; with none given and exactly one project on the account,
 * that one is used — the common case, and making an agent pass an id it has
 * to look up first is friction for nothing.
 */
async function resolveProject(
  userId: string,
  hint?: string,
): Promise<{ ok: true; id: string; name: string } | { ok: false; error: string }> {
  const sb = serviceClient();
  const [{ data: owned }, { data: memberships }] = await Promise.all([
    sb.from("projects").select("id, name, url").eq("owner_id", userId).limit(100),
    sb.from("project_members").select("project_id").eq("user_id", userId).limit(100),
  ]);
  const rows = (owned as Array<{ id: string; name: string; url: string }> | null) ?? [];
  const memberIds = ((memberships as Array<{ project_id: string }> | null) ?? []).map(
    (m) => m.project_id,
  );
  if (memberIds.length) {
    const { data: shared } = await sb
      .from("projects")
      .select("id, name, url")
      .in("id", memberIds)
      .limit(100);
    for (const r of (shared as Array<{ id: string; name: string; url: string }> | null) ?? []) {
      if (!rows.some((p) => p.id === r.id)) rows.push(r);
    }
  }
  if (!rows.length) {
    return { ok: false, error: "No projects on this account. Create one first — leads belong to a project." };
  }

  if (!hint) {
    if (rows.length === 1) return { ok: true, id: rows[0].id, name: rows[0].name };
    return {
      ok: false,
      error: `Which project? Pass project: ${rows.slice(0, 8).map((p) => `"${p.name}"`).join(", ")}`,
    };
  }

  const needle = hint.trim().toLowerCase();
  const match =
    rows.find((p) => p.id === hint) ??
    rows.find((p) => p.name.toLowerCase() === needle) ??
    rows.find((p) => normalizeHost(p.url) === normalizeHost(needle)) ??
    rows.find((p) => p.name.toLowerCase().includes(needle));
  if (!match) {
    return {
      ok: false,
      error: `No project matching "${hint}". Yours: ${rows.map((p) => p.name).join(", ")}`,
    };
  }
  return { ok: true, id: match.id, name: match.name };
}

type AuditRow = {
  id: string;
  target_url: string;
  score: number | null;
  engine: string;
  share_token: string | null;
};

export function registerLeadTools(server: McpServer): void {
  // ---------------------------------------------------------- find_leads
  server.registerTool(
    "find_leads",
    {
      description:
        "Find leads. source 'search' finds businesses by query ('dentists in Miami'); 'reddit' finds recent threads worth answering; 'scans' lists sites in your own completed CrawlProof scans that scored badly enough to pitch. Read-only — contacts nobody.",
      inputSchema: {
        project: z
          .string()
          .optional()
          .describe("Project id, name, or site URL. Optional when the account has exactly one project."),
        source: z
          .enum(["search", "reddit", "scans"])
          .optional()
          .describe("Default 'search'."),
        query: z.string().optional().describe("Search query for source='search'."),
        keywords: z
          .array(z.string())
          .optional()
          .describe("Problem phrases for source='reddit', e.g. ['llms.txt', 'ChatGPT cites competitor']."),
        subreddits: z.array(z.string()).optional().describe("Subreddits to search. Omit for all of Reddit."),
        seed_urls: z
          .array(z.string())
          .optional()
          .describe("Directory or listicle pages whose outbound links are candidates (source='search')."),
        limit: z.number().optional().describe("Max results. Default 10."),
        enrich: z
          .boolean()
          .optional()
          .describe("source='search': fetch each site for email/phone/address. Slower."),
        max_score: z.number().optional().describe("source='scans': only sites at or below this. Default 70."),
      },
    },
    async (args, extra) => {
      const userId = getUserId(extra);
      const project = await resolveProject(userId, args.project);
      if (!project.ok) return errorResult(project.error);
      const source = args.source ?? "search";
      const limit = Math.min(args.limit ?? 10, 30);

      // ---- Reddit threads
      if (source === "reddit") {
        if (!args.keywords?.length) return errorResult("source='reddit' needs keywords.");
        const res = await findRedditThreads({
          userId,
          keywords: args.keywords,
          subreddits: args.subreddits,
          limit,
        });
        if (!res.ok) return errorResult(res.error);
        if (!res.threads.length) return textResult(res.note ?? "No threads worth answering right now.");
        return textResult(
          [
            `${res.threads.length} thread${res.threads.length === 1 ? "" : "s"} worth answering (as u/${res.username}):`,
            "",
            ...res.threads.map((t) =>
              [
                `[${t.relevance}] r/${t.subreddit} — ${t.title}`,
                `    ${t.id} · u/${t.author} · ${t.ageHours}h old · ${t.numComments} comments`,
                `    ${t.reasons}`,
                t.ruleWarning ? `    ⚠ ${t.ruleWarning}` : "",
                `    ${t.permalink}`,
              ]
                .filter(Boolean)
                .join("\n"),
            ),
            "",
            `Next: draft_message({ channel: "reddit", thread_id: "…" }).`,
          ].join("\n"),
        );
      }

      // ---- Your own scans
      if (source === "scans") {
        const maxScore = args.max_score ?? 70;
        const sb = serviceClient();
        const { data } = await sb
          .from("audits")
          .select("id, target_url, score, engine, share_token")
          .eq("owner_id", userId)
          .eq("status", "complete")
          .order("completed_at", { ascending: false })
          .limit(500);
        const audits = (data as AuditRow[] | null) ?? [];
        const { data: existing } = await sb
          .from("outreach_prospects")
          .select("target_key")
          .eq("project_id", project.id)
          .eq("channel", "email");
        const known = new Set(
          ((existing as Array<{ target_key: string }> | null) ?? []).map((r) => r.target_key),
        );

        const seen = new Set<string>();
        const rows: string[] = [];
        for (const a of audits) {
          const host = hostOf(a.target_url);
          if (!host || seen.has(host) || known.has(host)) continue;
          seen.add(host);
          if (isThirdPartyHost(host)) continue;
          if (!isWeakEnough({ score: a.score, engine: a.engine, maxScore })) continue;
          if (await isEmailSuppressed(`x@${host}`)) continue;
          rows.push(
            `• ${host} — ${a.score}/100 (${a.engine})${a.share_token ? ` → ${siteBase()}/r/${a.share_token}` : ""}`,
          );
          if (rows.length >= limit) break;
        }
        if (!rows.length) {
          return textResult(
            `Nothing at or below ${maxScore}/100 in your completed scans. Try source='search' to find new leads.`,
          );
        }
        return textResult(
          `${rows.length} from your own scans:\n${rows.join("\n")}\n\nNext: research_lead({ url }).`,
        );
      }

      // ---- Business search
      if (!args.query && !args.seed_urls?.length) {
        return errorResult("source='search' needs a query or seed_urls.");
      }
      const found = await discoverProspects({
        queries: args.query ? [args.query] : [],
        seedUrls: args.seed_urls ?? [],
        limit,
      });
      if (!found.prospects.length) {
        return errorResult(`No businesses found. ${found.errors.join("; ")}`.trim());
      }

      const lines: string[] = [];
      for (const p of found.prospects.slice(0, limit)) {
        if (!args.enrich) {
          lines.push(`• ${p.label}\n    ${p.url}`);
          continue;
        }
        const { contact } = await enrichContact({ url: p.url });
        const best = contact.emails[0];
        lines.push(
          [
            `• ${p.label}`,
            `    ${p.url}`,
            best ? `    email: ${best.email}${best.sameDomain ? "" : " (OFF-DOMAIN)"}` : "    email: none published",
            contact.phones.length ? `    phone: ${contact.phones.join(", ")}` : "",
            contact.address ? `    address: ${contact.address}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
        );
      }
      return textResult(
        [
          `${found.prospects.length} result${found.prospects.length === 1 ? "" : "s"}${
            found.serpCalls ? ` (${found.serpCalls} billable SERP call${found.serpCalls === 1 ? "" : "s"})` : " (free)"
          }:`,
          "",
          ...lines,
          "",
          "Next: research_lead({ url }) — or campaign({ action: 'create' }) to run this query on a schedule.",
        ].join("\n"),
      );
    },
  );

  // ------------------------------------------------------- research_lead
  server.registerTool(
    "research_lead",
    {
      description:
        "Build the evidence file for one lead: reuse or start a free scan of their site, pull the findings, price the fix, and find the contact address they publish. Also does pure contact lookup (find_contact_only) and address guessing for a named person. Contacts nobody.",
      inputSchema: {
        project: z
          .string()
          .optional()
          .describe("Project id, name, or site URL. Optional when the account has exactly one project."),
        url: z.string().describe("The lead's site URL."),
        contact_email: z.string().optional().describe("Override the discovered address."),
        notes: z.string().optional().describe("Anything the scan can't tell you."),
        contact_only: z
          .boolean()
          .optional()
          .describe("Skip the scan; just return the contact details published on the site."),
        person: z
          .object({ firstName: z.string(), lastName: z.string() })
          .optional()
          .describe("Guess this person's address at the domain, ranked, with SMTP verification where possible."),
      },
    },
    async (args, extra) => {
      const userId = getUserId(extra);

      if (args.person) {
        const from = env.resendFrom.match(/<([^>]+)>/)?.[1] ?? "hello@crawlproof.com";
        const res = await findEmail({
          firstName: args.person.firstName,
          lastName: args.person.lastName,
          domain: args.url,
          fromAddress: from,
        });
        if (!res.guesses.length) return errorResult("Could not build candidates — check the name and domain.");
        return textResult(
          [
            `${args.person.firstName} ${args.person.lastName} @ ${normalizeHost(args.url)}`,
            res.mx ? `MX: ${res.mx}` : "MX: none — this domain does not accept mail.",
            res.catchAll ? "Catch-all: yes" : "",
            "",
            ...res.guesses
              .slice(0, 8)
              .map((g) => `  ${String(g.confidence).padStart(3)}%  ${g.email}  [${g.pattern}, ${g.verification}]`),
            "",
            res.note,
          ]
            .filter(Boolean)
            .join("\n"),
        );
      }

      if (args.contact_only) {
        const { contact, errors } = await enrichContact({ url: args.url });
        if (!contact.fetchedUrls.length) {
          return errorResult(`Couldn't read anything at ${args.url}. ${errors.slice(0, 3).join("; ")}`);
        }
        return textResult(
          [
            `${contact.host}${contact.title ? ` — ${contact.title}` : ""}`,
            contact.emails.length
              ? `Emails: ${contact.emails.map((e) => `${e.email}${e.sameDomain ? "" : " (OFF-DOMAIN)"}`).join(", ")}`
              : "Emails: none published.",
            contact.phones.length ? `Phones: ${contact.phones.join(", ")}` : "",
            contact.address ? `Address: ${contact.address}` : "",
            Object.entries(contact.socials).length
              ? `Social: ${Object.entries(contact.socials).map(([k, v]) => `${k}=${v}`).join(" ")}`
              : "",
          ]
            .filter(Boolean)
            .join("\n"),
        );
      }

      const project = await resolveProject(userId, args.project);
      if (!project.ok) return errorResult(project.error);
      const res = await researchProspect({
        userId,
        projectId: project.id,
        url: args.url,
        contactEmail: args.contact_email,
        notes: args.notes,
      });
      if (res.status === "error") return errorResult(res.message);
      if (res.status === "scanning") return textResult(res.message);

      const facts = factsOf(res.prospect);
      return textResult(
        [
          `${facts.host} — ${facts.score ?? "—"}/100 (${facts.kind})`,
          facts.reportUrl ? `Report: ${facts.reportUrl}` : "Report: (no share token)",
          res.contact
            ? `Contact: ${res.contact.email} (${res.contact.source}${
                res.contact.sameDomain ? ", own domain" : ", OFF-DOMAIN — verify this is really them"
              })`
            : "Contact: nothing published. Pass contact_email, or use `person` to guess an address.",
          "",
          "Findings to pitch from:",
          ...facts.topIssues.map((t) => `  • ${t}`),
          "",
          `Fix quote: ${res.quoteLabel}`,
          res.contact ? `\nNext: draft_message({ host: "${facts.host}" }).` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      );
    },
  );

  // ------------------------------------------------------- draft_message
  server.registerTool(
    "draft_message",
    {
      description:
        "Write the message. channel 'email' drafts from the lead's scan findings; channel 'reddit' drafts a reply to a specific thread. Returns it for review — sends nothing. Rejects its own output if it cites a score or report that doesn't exist, implies a prior relationship, or (on Reddit) leads with our link or omits the ownership disclosure.",
      inputSchema: {
        project: z
          .string()
          .optional()
          .describe("Project id, name, or site URL. Optional when the account has exactly one project."),
        channel: z.enum(["email", "reddit"]).optional().describe("Default 'email'."),
        host: z.string().optional().describe("Lead host, for channel='email'."),
        thread_id: z.string().optional().describe("Thread fullname (t3_…), for channel='reddit'."),
        step: z.number().optional().describe("Email only. 1 = first contact (default), 2 = follow-up, 3 = final."),
        angle: z.string().optional().describe("What to emphasise."),
        sender: z.string().optional().describe("Email sign-off. Default 'the CrawlProof team'."),
        reddit_channel: z
          .enum(["comment", "dm"])
          .optional()
          .describe("Reddit only. Default 'comment' — a public reply is better for everyone."),
        mention_product: z
          .boolean()
          .optional()
          .describe("Reddit only. Default true; false answers with no product mention at all."),
      },
    },
    async (args, extra) => {
      const userId = getUserId(extra);
      const channel = args.channel ?? "email";

      if (channel === "reddit") {
        if (!args.thread_id) return errorResult("channel='reddit' needs thread_id.");
        const res = await draftRedditReply({
          userId,
          threadId: args.thread_id,
          redditChannel: args.reddit_channel ?? "comment",
          angle: args.angle,
          mentionProduct: args.mention_product !== false,
        });
        if (!res.ok) return errorResult(res.error);
        return textResult(
          [
            `r/${res.subreddit} — ${res.title}`,
            res.permalink,
            `Replying as u/${res.username} via ${res.redditChannel === "dm" ? "private message" : "public comment"}`,
            "",
            res.body,
            "",
            "—",
            `Answers: ${res.answers}`,
            "",
            `Post with: send_message({ channel: "reddit", thread_id: "${args.thread_id}", body: "…" }) — dry run unless dry_run: false.`,
          ].join("\n"),
        );
      }

      if (!args.host) return errorResult("channel='email' needs host.");
      const project = await resolveProject(userId, args.project);
      if (!project.ok) return errorResult(project.error);
      const prospect = await loadProspect(project.id, args.host);
      if (!prospect) {
        return errorResult(
          `No lead for ${normalizeHost(args.host)} in ${project.name} — run research_lead first.`,
        );
      }
      const step = Math.min(Math.max(args.step ?? 1, 1), 3) as OutreachStep;

      // Sequence discipline: step 2 four days after step 1, step 3 a week
      // after that. Two cold emails in two days is the same message twice.
      if (step > 1 && prospect.last_sent_at) {
        const ready = nextStepReadyAt(new Date(prospect.last_sent_at), step);
        if (ready.getTime() > Date.now()) {
          return errorResult(
            `Step ${step} isn't due until ${ready.toISOString().slice(0, 10)} (last contact ${prospect.last_sent_at.slice(0, 10)}).`,
          );
        }
      }

      const draft = await draftEmail({ prospect, step, angle: args.angle, sender: args.sender });
      if (!draft.ok) {
        return errorResult(`Draft rejected:\n${draft.problems.map((p) => `  • ${p}`).join("\n")}`);
      }
      const facts = factsOf(prospect);
      await serviceClient()
        .from("outreach_prospects")
        .update({ status: prospect.status === "new" ? "drafted" : prospect.status })
        .eq("id", prospect.id);

      return textResult(
        [
          `To: ${prospect.contact_email ?? "(no address on file)"}`,
          `Subject: ${draft.subject}`,
          "",
          draft.body,
          "",
          "—",
          `Cites: ${draft.evidenceUsed.join("; ") || "(none listed)"}`,
          facts.reportUrl ? `Report button links to: ${facts.reportUrl}` : "No report link will be attached.",
          "",
          `Send with: send_message({ host: "${facts.host}", subject: "…", body: "…", step: ${step} }) — dry run unless dry_run: false.`,
        ].join("\n"),
      );
    },
  );

  // -------------------------------------------------------- send_message
  server.registerTool(
    "send_message",
    {
      description:
        "The only tool that contacts anyone. DRY RUN BY DEFAULT — pass dry_run: false to actually send. Email refuses on: do-not-contact, prior unsubscribe, machine mailboxes, a repeat of the same step, the daily cap, or a missing CAN-SPAM postal address. Reddit refuses on: the subreddit's own no-promotion rule, a user already DM'd, a thread already replied to, and the daily/per-subreddit caps. Every attempt is logged either way.",
      inputSchema: {
        project: z
          .string()
          .optional()
          .describe("Project id, name, or site URL. Optional when the account has exactly one project."),
        channel: z.enum(["email", "reddit"]).optional().describe("Default 'email'."),
        body: z.string().describe("The reviewed message body."),
        host: z.string().optional().describe("Lead host, for channel='email'."),
        subject: z.string().optional().describe("Email subject, or DM subject on Reddit."),
        step: z.number().optional().describe("Email sequence step 1-3. Default 1."),
        to: z.string().optional().describe("Email only: override the stored address."),
        reply_to: z.string().optional().describe("Email only: Reply-To. Strongly recommended."),
        thread_id: z.string().optional().describe("Thread fullname, for channel='reddit'."),
        reddit_channel: z.enum(["comment", "dm"]).optional().describe("Reddit only. Default 'comment'."),
        campaign: z.string().optional().describe("Campaign name for the log."),
        dry_run: z.boolean().optional().describe("Default true."),
      },
    },
    async (args, extra) => {
      const userId = getUserId(extra);
      const project = await resolveProject(userId, args.project);
      if (!project.ok) return errorResult(project.error);
      const channel = args.channel ?? "email";
      const dryRun = args.dry_run !== false;

      if (channel === "reddit") {
        if (!args.thread_id) return errorResult("channel='reddit' needs thread_id.");
        const res = await sendRedditOutreach({
          userId,
          projectId: project.id,
          threadId: args.thread_id,
          body: args.body,
          subject: args.subject,
          redditChannel: args.reddit_channel ?? "comment",
          campaign: args.campaign?.trim() || "reddit-outreach",
          dryRun,
        });
        if (!res.ok) return errorResult(res.error);
        return textResult(res.message);
      }

      if (!args.host) return errorResult("channel='email' needs host.");
      if (!args.subject) return errorResult("channel='email' needs a subject.");
      const prospect = await loadProspect(project.id, args.host);
      if (!prospect) {
        return errorResult(`No lead for ${normalizeHost(args.host)} in ${project.name} — run research_lead first.`);
      }

      const step = Math.min(Math.max(args.step ?? 1, 1), 3) as OutreachStep;
      const outcome = await sendProspectEmail({
        userId,
        prospect,
        subject: args.subject,
        body: args.body,
        step,
        campaign: args.campaign?.trim() || "cold-outreach",
        to: args.to,
        replyTo: args.reply_to,
        dryRun,
      });
      if (!outcome.ok) return errorResult(`Not sent — ${outcome.reason}.`);

      const unsubscribeUrl = `${siteBase()}/unsubscribe/${prospect.unsubscribe_token}`;
      return textResult(
        outcome.dryRun
          ? [
              "DRY RUN — nothing was sent.",
              `To: ${outcome.to}`,
              `Subject: ${args.subject}`,
              `Step ${step}`,
              `Unsubscribe link: ${unsubscribeUrl}`,
              env.outreachPostalAddress
                ? `Postal address in footer: ${env.outreachPostalAddress}`
                : "⚠ OUTREACH_POSTAL_ADDRESS unset — live sending will be refused until it is.",
              `Sends used today: ${outcome.sentToday}/${env.outreachDailyCap}`,
              "",
              "Pass dry_run: false to send it.",
            ].join("\n")
          : `Sent to ${outcome.to} — step ${step}. ${outcome.sentToday + 1}/${env.outreachDailyCap} sends used today.`,
      );
    },
  );

  // ------------------------------------------------------------ campaign
  server.registerTool(
    "campaign",
    {
      description:
        "The autopilot. action 'create' sets up a campaign (search queries and/or directory pages, targeting, caps); 'update' changes one — {action:'update', name, active:false} is the kill switch; 'run' runs one tick now; 'list' shows them all. A campaign discovers, scans, researches and drafts on its own; it only SENDS when auto_send is true, which defaults false.",
      inputSchema: {
        project: z
          .string()
          .optional()
          .describe("Project id, name, or site URL. Optional when the account has exactly one project."),
        action: z.enum(["create", "update", "run", "list"]).describe("What to do."),
        name: z.string().optional().describe("Campaign name. Required for create/update/run."),
        queries: z.array(z.string()).optional().describe("Search queries, e.g. ['dentists in Miami']."),
        seed_urls: z.array(z.string()).optional().describe("Directory pages whose outbound links are leads."),
        max_score: z.number().optional().describe("Only pitch sites at or below this score. Default 70."),
        daily_send_limit: z.number().optional().describe("Live sends per day. Default 10."),
        target_pipeline: z.number().optional().describe("Leads to keep in the funnel. Default 25."),
        auto_send: z.boolean().optional().describe("Default FALSE — build and draft, but don't send."),
        follow_ups: z.boolean().optional().describe("Send steps 2 and 3 on schedule. Default true."),
        angle: z.string().optional().describe("Standing emphasis for every draft."),
        sender_name: z.string().optional().describe("Sign-off name."),
        reply_to: z.string().optional().describe("Reply-To address."),
        active: z.boolean().optional().describe("Whether the cron tick runs it."),
      },
    },
    async (args, extra) => {
      const userId = getUserId(extra);
      const project = await resolveProject(userId, args.project);
      if (!project.ok) return errorResult(project.error);
      const sb = serviceClient();

      if (args.action === "list") {
        const { data } = await sb
          .from("outreach_campaigns")
          .select("name, active, auto_send, daily_send_limit, max_score, last_run_at, last_run_note")
          .eq("project_id", project.id)
          .order("updated_at", { ascending: false })
          .limit(20);
        const rows = (data as Array<Record<string, unknown>> | null) ?? [];
        if (!rows.length) return textResult("No campaigns yet. campaign({ action: 'create', name, queries }).");
        return textResult(
          rows
            .map(
              (c) =>
                `• ${c.name} — ${c.active ? "active" : "paused"}, auto_send ${c.auto_send ? "ON" : "off"}, ${c.daily_send_limit}/day, ≤${c.max_score}/100${
                  c.last_run_at ? `\n    last tick ${String(c.last_run_at).slice(0, 16)}: ${c.last_run_note ?? ""}` : "\n    never run"
                }`,
            )
            .join("\n"),
        );
      }

      if (!args.name) return errorResult(`action '${args.action}' needs a name.`);

      if (args.action === "run") {
        const { data } = await sb
          .from("outreach_campaigns")
          .select(CAMPAIGN_COLUMNS)
          .eq("project_id", project.id)
          .ilike("name", args.name)
          .maybeSingle();
        if (!data) return errorResult(`No campaign named "${args.name}" in ${project.name}.`);
        const result = await runEmailCampaignTick(data as CampaignRow);
        return textResult(
          [
            `"${result.campaign}": ${summarize(result)}`,
            result.skipped.length ? `\nSkipped:\n${result.skipped.map((s) => `  • ${s}`).join("\n")}` : "",
            result.errors.length ? `\nErrors:\n${result.errors.slice(0, 10).map((s) => `  • ${s}`).join("\n")}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
        );
      }

      if (args.action === "update") {
        const patch: Record<string, unknown> = {};
        for (const key of [
          "active", "auto_send", "max_score", "daily_send_limit", "target_pipeline",
          "follow_ups", "queries", "seed_urls", "angle", "sender_name", "reply_to",
        ] as const) {
          if (args[key] !== undefined) patch[key] = args[key];
        }
        if (!Object.keys(patch).length) return errorResult("Nothing to change.");
        const { data, error } = await sb
          .from("outreach_campaigns")
          .update(patch)
          .eq("project_id", project.id)
          .ilike("name", args.name)
          .select(CAMPAIGN_COLUMNS)
          .maybeSingle();
        if (error) return errorResult(error.message);
        if (!data) return errorResult(`No campaign named "${args.name}".`);
        const c = data as CampaignRow;
        return textResult(
          `"${c.name}" updated — ${c.active ? "active" : "PAUSED"}, auto_send ${c.auto_send ? "ON" : "off"}, ${c.daily_send_limit}/day, pitching ≤${c.max_score}/100.`,
        );
      }

      // create
      if (!args.queries?.length && !args.seed_urls?.length) {
        return errorResult("A campaign needs at least one search query or seed URL, or it finds nothing.");
      }
      const { data, error } = await sb
        .from("outreach_campaigns")
        .upsert(
          {
            project_id: project.id,
            owner_id: userId,
            name: args.name,
            channel: "email",
            active: args.active !== false,
            queries: args.queries ?? [],
            seed_urls: args.seed_urls ?? [],
            max_score: args.max_score ?? 70,
            daily_send_limit: args.daily_send_limit ?? 10,
            target_pipeline: args.target_pipeline ?? 25,
            auto_send: args.auto_send === true,
            follow_ups: args.follow_ups !== false,
            angle: args.angle ?? null,
            sender_name: args.sender_name ?? null,
            reply_to: args.reply_to ?? null,
          },
          { onConflict: "project_id,name" },
        )
        .select(CAMPAIGN_COLUMNS)
        .maybeSingle();
      if (error || !data) return errorResult(error?.message ?? "Could not create the campaign.");
      const c = data as CampaignRow;
      return textResult(
        [
          `Campaign "${c.name}" ${c.active ? "is active" : "is paused"}.`,
          `Sources: ${[...(c.queries ?? []), ...(c.seed_urls ?? [])].join(" | ") || "none"}`,
          `Pitches sites ≤${c.max_score}/100, up to ${c.daily_send_limit} sends/day, funnel target ${c.target_pipeline}.`,
          c.auto_send
            ? "⚠ auto_send is ON — this will email real people on the cron tick."
            : "auto_send is OFF: it discovers, scans, researches and drafts, logging each message as a dry run. Read a few, then turn sending on.",
          "",
          `Run one tick now: campaign({ action: "run", name: "${c.name}" }).`,
        ].join("\n"),
      );
    },
  );

  // --------------------------------------------------------------- leads
  server.registerTool(
    "leads",
    {
      description:
        "Your pipeline: where every lead stands, what campaigns are running, what actually went out in the last 24h, and how much of the daily cap is left. Pass format 'csv' or 'json' to export instead.",
      inputSchema: {
        project: z
          .string()
          .optional()
          .describe("Project id, name, or site URL. Optional when the account has exactly one project."),
        status: z.string().optional().describe("Filter: new, researched, drafted, contacted, replied, won, lost, skipped."),
        host: z.string().optional().describe("Limit to one lead."),
        format: z.enum(["summary", "csv", "json"]).optional().describe("Default 'summary'."),
        limit: z.number().optional().describe("Max rows. Default 25 (500 when exporting)."),
      },
    },
    async (args, extra) => {
      const userId = getUserId(extra);
      const project = await resolveProject(userId, args.project);
      if (!project.ok) return errorResult(project.error);
      const sb = serviceClient();
      const format = args.format ?? "summary";

      if (format !== "summary") {
        let q = sb
          .from("outreach_prospects")
          .select(
            "target_key, channel, status, score, score_kind, contact_email, contact_source, quote_usd, top_issues, report_token, site_url, discovered_via, discovery_label, last_sent_at, last_step, created_at",
          )
          .eq("project_id", project.id)
          .order("created_at", { ascending: false })
          .limit(Math.min(args.limit ?? 500, 2000));
        if (args.status) q = q.eq("status", args.status);
        const { data, error } = await q;
        if (error) return errorResult(error.message);
        const rows = (data as Array<Record<string, unknown>> | null) ?? [];
        if (!rows.length) return textResult("No leads match that filter.");
        const leads: ExportableLead[] = rows.map((r) => ({
          host: r.target_key,
          channel: r.channel,
          status: r.status,
          score: r.score,
          email: r.contact_email,
          quote_usd: r.quote_usd,
          top_issues: r.top_issues,
          report_url: r.report_token ? `${siteBase()}/r/${r.report_token}` : "",
          site_url: r.site_url,
          found_via: r.discovered_via,
          found_as: r.discovery_label,
          last_contacted: r.last_sent_at,
          last_step: r.last_step,
          created_at: r.created_at,
        }));
        return textResult(
          `${leads.length} lead${leads.length === 1 ? "" : "s"} (${format}):\n\n${
            format === "json" ? leadsToJson(leads) : leadsToCsv(leads)
          }`,
        );
      }

      const limit = Math.min(args.limit ?? 25, 100);
      let prospectQuery = sb
        .from("outreach_prospects")
        .select("target_key, channel, status, score, contact_email, last_sent_at, last_step")
        .eq("project_id", project.id)
        .order("updated_at", { ascending: false })
        .limit(100);
      if (args.host) prospectQuery = prospectQuery.eq("target_key", normalizeHost(args.host));
      if (args.status) prospectQuery = prospectQuery.eq("status", args.status);

      const [{ data: prospects }, { data: sends }, { data: campaigns }] = await Promise.all([
        prospectQuery,
        sb
          .from("outreach_sends")
          .select("channel, campaign, step, recipient, subject, dry_run, sent_at")
          .eq("project_id", project.id)
          .order("sent_at", { ascending: false })
          .limit(15),
        sb
          .from("outreach_campaigns")
          .select("name, active, auto_send, daily_send_limit, last_run_at, last_run_note")
          .eq("project_id", project.id)
          .order("updated_at", { ascending: false })
          .limit(10),
      ]);

      const emailToday = await sendsInLast24h({ ownerId: userId, channels: ["email"] });
      const redditToday = await sendsInLast24h({
        ownerId: userId,
        channels: ["reddit_comment", "reddit_dm"],
      });

      const byStatus = new Map<string, number>();
      for (const p of (prospects as Array<{ status: string }> | null) ?? []) {
        byStatus.set(p.status, (byStatus.get(p.status) ?? 0) + 1);
      }

      return textResult(
        [
          `${project.name} pipeline: ${[...byStatus.entries()].map(([s, n]) => `${n} ${s}`).join(", ") || "empty"}`,
          `Caps used (rolling 24h): email ${emailToday}/${env.outreachDailyCap}, reddit ${redditToday}/${env.redditOutreachDailyCap}`,
          "",
          "Campaigns:",
          ...((campaigns as Array<Record<string, unknown>> | null) ?? []).map(
            (c) =>
              `  • ${c.name} — ${c.active ? "active" : "paused"}, auto_send ${c.auto_send ? "ON" : "off"}${
                c.last_run_at ? `, last tick: ${c.last_run_note ?? ""}` : ", never run"
              }`,
          ),
          "",
          "Leads:",
          ...((prospects as Array<Record<string, unknown>> | null) ?? [])
            .slice(0, limit)
            .map(
              (p) =>
                `  • ${p.target_key} [${p.channel}] — ${p.status}${p.score !== null ? `, ${p.score}/100` : ""}${
                  p.contact_email ? `, ${p.contact_email}` : ""
                }${p.last_sent_at ? `, step ${p.last_step} on ${String(p.last_sent_at).slice(0, 10)}` : ""}`,
            ),
          "",
          "Recent sends:",
          ...((sends as Array<Record<string, unknown>> | null) ?? []).map(
            (s) =>
              `  ${s.dry_run ? "· dry" : "✓ live"} ${String(s.sent_at).slice(0, 16)} ${s.channel} step ${s.step} → ${s.recipient} — ${s.subject ?? ""}`,
          ),
        ].join("\n"),
      );
    },
  );

  // ------------------------------------------------------------ suppress
  server.registerTool(
    "suppress",
    {
      description:
        "Add an address, a whole domain, or a Reddit user to the global do-not-contact list. Use it the moment someone asks to be left alone. Immediate, across every channel, for every CrawlProof user.",
      inputSchema: {
        value: z.string().describe("Email address, domain, or reddit username."),
        scope: z
          .enum(["email", "domain", "reddit_user"])
          .optional()
          .describe("Inferred when omitted: an address with @ is 'email', otherwise 'domain'."),
        reason: z.string().optional().describe("For the record, e.g. 'replied asking to stop'."),
      },
    },
    async (args, extra) => {
      const userId = getUserId(extra);
      const scope = args.scope ?? (args.value.includes("@") ? "email" : "domain");
      const res = await addSuppression({ scope, value: args.value, reason: args.reason, addedBy: userId });
      if (!res.ok) return errorResult(res.error ?? "Could not add the suppression.");
      return textResult(`${args.value} is on the do-not-contact list (scope: ${scope}). No channel will reach them.`);
    },
  );
}
