// Performance-report digest — per-user aggregation of audit projects +
// autoblog activity for the last week or last month.
//
// The cron picks who to send to; this module is pure data + render +
// send, callable from anywhere with a service client.

import type { SupabaseClient } from "@supabase/supabase-js";
import { Resend } from "resend";
import { env } from "./env";

const DAY_MS = 24 * 60 * 60 * 1000;

export type Cadence = "daily" | "weekly" | "monthly";

export type ProjectRow = {
  id: string;
  name: string;
  targetUrl: string;
  latestScore: number | null;
  priorScore: number | null;
  auditsInWindow: number;
};

export type AutoblogSummary = {
  domain: string;
  articlesPublished: number;
  articlesFailed: number;
  queuedKeywords: number;
  nextPublishAt: string | null;
} | null;

/**
 * A property's last-24h traffic, split the way the tracker splits it: a
 * bucket starting `bot:` is a crawler, everything else is a human. AI
 * referrals count as humans on purpose — someone asked a model and came.
 */
export type TrafficRow = {
  projectId: string;
  name: string;
  humans: number;
  bots: number;
  total: number;
};

export type TrafficSummary = {
  humans: number;
  bots: number;
  total: number;
  /** Most to least traffic. */
  properties: TrafficRow[];
};

export type PerfReport = {
  userId: string;
  userEmail: string;
  userDisplayName: string;
  cadence: Cadence;
  windowStart: Date;
  windowEnd: Date;
  projects: ProjectRow[];
  autoblog: AutoblogSummary;
  /** Present on every cadence; it is the point of the nightly one. */
  traffic: TrafficSummary;
};

function windowDays(cadence: Cadence): number {
  if (cadence === "daily") return 1;
  return cadence === "weekly" ? 7 : 30;
}

// ------------------------------------------------------------
// TZ-aware due check
// ------------------------------------------------------------
//
// The cron fires at the top of every hour (UTC). For each user, we
// project the current instant into their timezone and check whether
// it's currently "their" send slot:
//   weekly:  Monday 09:00 local
//   monthly: 1st  09:00 local
// The hour match is exact (only one cron tick per day per user is
// eligible). last_sent_at gates dedupe in case a cron tick runs twice.

const WEEKDAY_MAP: Record<string, number> = {
  Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7,
};

export function partsInTimezone(
  d: Date,
  tz: string,
): { weekday: number; day: number; hour: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
    day: "numeric",
    hour: "numeric",
    hour12: false,
  }).formatToParts(d);
  const weekdayStr = parts.find((p) => p.type === "weekday")?.value ?? "Mon";
  const dayStr = parts.find((p) => p.type === "day")?.value ?? "1";
  const hourStr = parts.find((p) => p.type === "hour")?.value ?? "0";
  return {
    weekday: WEEKDAY_MAP[weekdayStr] ?? 1,
    day: parseInt(dayStr, 10),
    hour: parseInt(hourStr, 10) % 24, // Intl on Node can emit "24" at midnight
  };
}

export function isReportDue(
  cadence: Cadence,
  tz: string,
  now: Date,
  lastSentAt: Date | null,
): boolean {
  let local: { weekday: number; day: number; hour: number };
  try {
    local = partsInTimezone(now, tz);
  } catch {
    // Bad timezone string — fall back to UTC parts.
    local = partsInTimezone(now, "UTC");
  }
  if (local.hour !== 9) return false;

  if (cadence === "daily") {
    // One tick a day is eligible, and 20h of dedupe covers a DST shift
    // without ever letting two sends land in the same local day.
    if (lastSentAt && now.getTime() - lastSentAt.getTime() < 20 * 60 * 60 * 1000) {
      return false;
    }
    return true;
  }

  if (cadence === "weekly") {
    if (local.weekday !== 1) return false; // Mon
    if (
      lastSentAt &&
      now.getTime() - lastSentAt.getTime() < 6 * 24 * 60 * 60 * 1000
    ) {
      return false;
    }
    return true;
  }

  if (cadence === "monthly") {
    if (local.day !== 1) return false;
    if (
      lastSentAt &&
      now.getTime() - lastSentAt.getTime() < 27 * 24 * 60 * 60 * 1000
    ) {
      return false;
    }
    return true;
  }

  return false;
}

/**
 * Traffic per property over the window, most to least.
 *
 * `tracker_daily_stats` is already bucketed per day, so this is a read of
 * whole days rather than a rolling window — a nightly report at 09:00 local
 * wants "yesterday and today so far", which is what `days` back from today
 * gives. Counting is by bucket because that is the only place the human/bot
 * split exists: `tracker_event_daily_stats` has no bucket column and its
 * pageview counts include crawlers.
 */
async function aggregateTraffic(
  supabase: SupabaseClient<any>,
  projects: { id: string; name: string }[],
  days: number,
  now: Date,
): Promise<TrafficSummary> {
  const empty: TrafficSummary = { humans: 0, bots: 0, total: 0, properties: [] };
  if (!projects.length) return empty;

  const since = new Date(now.getTime() - days * DAY_MS).toISOString().slice(0, 10);
  const { data } = await supabase
    .from("tracker_daily_stats")
    .select("project_id, bucket, count")
    .in(
      "project_id",
      projects.map((project) => project.id),
    )
    .gte("day", since);

  const byProject = new Map<string, { humans: number; bots: number }>();
  for (const row of (data ?? []) as { project_id: string; bucket: string; count: number }[]) {
    const tally = byProject.get(row.project_id) ?? { humans: 0, bots: 0 };
    if (row.bucket?.startsWith("bot:")) tally.bots += row.count ?? 0;
    else tally.humans += row.count ?? 0;
    byProject.set(row.project_id, tally);
  }

  const properties: TrafficRow[] = projects
    .map((project) => {
      const tally = byProject.get(project.id) ?? { humans: 0, bots: 0 };
      return {
        projectId: project.id,
        name: project.name,
        humans: tally.humans,
        bots: tally.bots,
        total: tally.humans + tally.bots,
      };
    })
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));

  return {
    humans: properties.reduce((sum, row) => sum + row.humans, 0),
    bots: properties.reduce((sum, row) => sum + row.bots, 0),
    total: properties.reduce((sum, row) => sum + row.total, 0),
    properties,
  };
}

export async function aggregatePerfReport(
  supabase: SupabaseClient<any>,
  userId: string,
  cadence: Cadence,
  now: Date = new Date(),
): Promise<PerfReport | null> {
  const days = windowDays(cadence);
  const windowStart = new Date(now.getTime() - days * DAY_MS);

  const { data: profile } = await supabase
    .from("profiles")
    .select("id, email, display_name")
    .eq("id", userId)
    .maybeSingle();
  if (!profile?.email) return null;

  const { data: projects } = await supabase
    .from("projects")
    .select("id, name, url")
    .eq("owner_id", userId);

  const projectRows: ProjectRow[] = await Promise.all(
    (projects ?? []).map(async (p: any) => {
      const [{ data: latest }, { data: prior }, { count: auditsInWindow }] =
        await Promise.all([
          supabase
            .from("audits")
            .select("score")
            .eq("project_id", p.id)
            .eq("status", "complete")
            .not("score", "is", null)
            .order("completed_at", { ascending: false })
            .limit(1)
            .maybeSingle(),
          supabase
            .from("audits")
            .select("score")
            .eq("project_id", p.id)
            .eq("status", "complete")
            .not("score", "is", null)
            .lt("completed_at", windowStart.toISOString())
            .order("completed_at", { ascending: false })
            .limit(1)
            .maybeSingle(),
          supabase
            .from("audits")
            .select("id", { count: "exact", head: true })
            .eq("project_id", p.id)
            .gte("completed_at", windowStart.toISOString()),
        ]);
      return {
        id: p.id,
        name: p.name,
        targetUrl: p.url,
        latestScore: (latest?.score as number | null) ?? null,
        priorScore: (prior?.score as number | null) ?? null,
        auditsInWindow: auditsInWindow ?? 0,
      };
    }),
  );

  const { data: site } = await supabase
    .from("lx_site")
    .select("id, domain, next_publish_at")
    .eq("user_id", userId)
    .maybeSingle();

  let autoblog: AutoblogSummary = null;
  if (site) {
    const [{ count: published }, { count: failed }, { count: queued }] =
      await Promise.all([
        supabase
          .from("lx_article")
          .select("id", { count: "exact", head: true })
          .eq("site_id", site.id)
          .eq("status", "published")
          .gte("published_at", windowStart.toISOString()),
        supabase
          .from("lx_article")
          .select("id", { count: "exact", head: true })
          .eq("site_id", site.id)
          .eq("status", "failed")
          .gte("created_at", windowStart.toISOString()),
        supabase
          .from("lx_keyword")
          .select("id", { count: "exact", head: true })
          .eq("site_id", site.id)
          .eq("status", "queued"),
      ]);
    autoblog = {
      domain: site.domain,
      articlesPublished: published ?? 0,
      articlesFailed: failed ?? 0,
      queuedKeywords: queued ?? 0,
      nextPublishAt: site.next_publish_at,
    };
  }

  return {
    userId,
    userEmail: profile.email,
    userDisplayName: profile.display_name ?? "",
    cadence,
    windowStart,
    windowEnd: now,
    projects: projectRows,
    autoblog,
    traffic: await aggregateTraffic(
      supabase,
      (projects ?? []).map((project: any) => ({ id: project.id, name: project.name })),
      days,
      now,
    ),
  };
}

// ------------------------------------------------------------
// Render
// ------------------------------------------------------------

function scoreAccent(score: number | null): string {
  if (score === null) return "#475569";
  if (score >= 80) return "#6ee7b7";
  if (score >= 60) return "#fcd34d";
  return "#fca5a5";
}

function deltaLabel(latest: number | null, prior: number | null): string {
  if (latest === null || prior === null) return "—";
  const delta = latest - prior;
  if (delta === 0) return "no change";
  const sign = delta > 0 ? "+" : "";
  return `${sign}${delta} vs last ${"period"}`;
}

export function renderPerfReportEmail(r: PerfReport): {
  subject: string;
  html: string;
} {
  const window =
    r.cadence === "daily" ? "today" : r.cadence === "weekly" ? "this week" : "this month";
  // The nightly one leads with the number the reader actually wants.
  const subject =
    r.cadence === "daily"
      ? `CrawlProof nightly — ${fmt(r.traffic.humans)} human visit${r.traffic.humans === 1 ? "" : "s"}, ${fmt(r.traffic.bots)} bot`
      : r.projects.length === 0 && !r.autoblog
        ? `Your CrawlProof ${r.cadence} digest`
        : `CrawlProof ${r.cadence} digest — ${r.projects.length} project${r.projects.length === 1 ? "" : "s"}${r.autoblog ? " + Autoblog" : ""}`;

  const projectRowsHtml = r.projects.length
    ? r.projects
        .map((p) => {
          const accent = scoreAccent(p.latestScore);
          return `<tr>
            <td style="padding:12px 0;border-top:1px solid #1f2630;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="vertical-align:top;">
                    <div style="color:#e7e9ee;font-size:14px;font-weight:600;">${escapeHtml(p.name)}</div>
                    <div style="color:#64748b;font-size:12px;margin-top:2px;">${escapeHtml(p.targetUrl)}</div>
                    <div style="color:#94a3b8;font-size:12px;margin-top:6px;">${p.auditsInWindow} audit${p.auditsInWindow === 1 ? "" : "s"} ${window} · ${deltaLabel(p.latestScore, p.priorScore)}</div>
                  </td>
                  <td align="right" style="vertical-align:top;white-space:nowrap;padding-left:12px;">
                    <span style="display:inline-block;padding:6px 10px;border-radius:999px;background:${accent};color:#0b0d10;font-weight:700;font-size:14px;min-width:36px;text-align:center;">
                      ${p.latestScore ?? "—"}
                    </span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>`;
        })
        .join("")
    : `<tr><td style="padding:12px 0;color:#64748b;font-size:13px;">No projects yet. <a href="${env.siteUrl}/dashboard/projects/new" style="color:#6ee7b7;">Add one</a>.</td></tr>`;

  const autoblogBlock = r.autoblog
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:24px;">
        <tr>
          <td style="padding:0 0 8px;color:#94a3b8;font-size:11px;text-transform:uppercase;letter-spacing:0.08em;">Autoblog · ${escapeHtml(r.autoblog.domain)}</td>
        </tr>
        <tr>
          <td>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;border-spacing:8px 0;">
              <tr>
                ${statCell("Published", r.autoblog.articlesPublished)}
                ${statCell("Failed", r.autoblog.articlesFailed, r.autoblog.articlesFailed > 0 ? "#fca5a5" : undefined)}
                ${statCell("Queued", r.autoblog.queuedKeywords)}
              </tr>
            </table>
          </td>
        </tr>
        ${
          r.autoblog.nextPublishAt
            ? `<tr><td style="padding-top:8px;color:#64748b;font-size:12px;">Next publish: ${escapeHtml(new Date(r.autoblog.nextPublishAt).toUTCString())}</td></tr>`
            : ""
        }
      </table>`
    : "";

  const trafficRowsHtml = r.traffic.properties.length
    ? r.traffic.properties
        .map((row) => {
          const share = row.total ? Math.round((row.bots / row.total) * 100) : 0;
          return `<tr>
            <td style="padding:10px 0;border-top:1px solid #1f2630;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="vertical-align:top;">
                    <div style="color:#e7e9ee;font-size:14px;font-weight:600;">${escapeHtml(row.name)}</div>
                    <div style="color:#94a3b8;font-size:12px;margin-top:4px;">${fmt(row.humans)} human · ${fmt(row.bots)} bot (${share}%)</div>
                  </td>
                  <td align="right" style="vertical-align:top;white-space:nowrap;padding-left:12px;color:#e7e9ee;font-size:16px;font-weight:700;">
                    ${fmt(row.total)}
                  </td>
                </tr>
              </table>
            </td>
          </tr>`;
        })
        .join("")
    : `<tr><td style="padding:10px 0;color:#64748b;font-size:13px;">No traffic recorded. Is the tracker tag on the site?</td></tr>`;

  const trafficBlock = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:24px;">
      <tr>
        <td style="padding:0 0 8px;color:#94a3b8;font-size:11px;text-transform:uppercase;letter-spacing:0.08em;">Traffic · last ${r.cadence === "daily" ? "24 hours" : window.replace(/^this /, "")}</td>
      </tr>
      <tr>
        <td>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;border-spacing:8px 0;">
            <tr>
              ${statCell("Humans", r.traffic.humans, "#6ee7b7")}
              ${statCell("Bots", r.traffic.bots)}
              ${statCell("All hits", r.traffic.total)}
            </tr>
          </table>
        </td>
      </tr>
      <tr><td><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:8px;">${trafficRowsHtml}</table></td></tr>
    </table>`;

  const innerHtml = `<tr>
    <td style="padding:16px 32px 24px;">
      <h1 style="margin:0 0 4px;font-size:20px;font-weight:700;color:#e7e9ee;">Your ${r.cadence} digest</h1>
      <p style="margin:0 0 16px;color:#64748b;font-size:13px;">Traffic, audits and Autoblog for ${window.replace(/^this /, "")}, busiest property first.</p>
      ${trafficBlock}
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        ${projectRowsHtml}
      </table>
      ${autoblogBlock}
      <p style="margin:24px 0 0;font-size:12px;color:#64748b;">
        <a href="${env.siteUrl}/dashboard" style="color:#6ee7b7;">Open dashboard</a>
        &nbsp;·&nbsp;
        <a href="${env.siteUrl}/dashboard/settings" style="color:#6ee7b7;">Change cadence or unsubscribe</a>
      </p>
    </td>
  </tr>`;

  const html = perfShell({ title: subject, innerHtml });
  return { subject, html };
}

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

function statCell(label: string, value: number, accent?: string): string {
  return `<td width="33%" valign="top" style="background:#0f1418;border:1px solid #1f2630;border-radius:10px;padding:12px;">
    <div style="color:#94a3b8;font-size:11px;text-transform:uppercase;letter-spacing:0.08em;">${escapeHtml(label)}</div>
    <div style="margin-top:4px;font-size:22px;font-weight:800;color:${accent ?? "#e7e9ee"};">${value}</div>
  </td>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export async function sendPerfReportEmail(
  to: string,
  report: PerfReport,
): Promise<{ ok: boolean; id?: string; error?: string }> {
  if (!env.resendApiKey) return { ok: false, error: "RESEND_API_KEY not set" };
  const { subject, html } = renderPerfReportEmail(report);
  const resend = new Resend(env.resendApiKey);
  const res = await resend.emails.send({
    from: env.resendFrom,
    to,
    subject,
    html,
  });
  if (res.error) return { ok: false, error: String(res.error) };
  return { ok: true, id: res.data?.id };
}

function perfShell(input: { title: string; innerHtml: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(input.title)}</title>
</head>
<body style="margin:0;padding:0;background:#0b0d10;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#e7e9ee;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#0b0d10;padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background:#12161c;border:1px solid #1f2630;border-radius:14px;overflow:hidden;">
          <tr>
            <td style="padding:28px 32px 0;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="padding-right:10px;vertical-align:middle;">
                    <div style="width:10px;height:10px;background:#6ee7b7;border-radius:999px;"></div>
                  </td>
                  <td style="vertical-align:middle;color:#e7e9ee;font-weight:700;font-size:16px;">CrawlProof</td>
                </tr>
              </table>
            </td>
          </tr>
          ${input.innerHtml}
        </table>
        <p style="margin:18px 0 0;font-size:11px;color:#475569;">
          CrawlProof · <a href="${env.siteUrl}" style="color:#64748b;">${env.siteUrl}</a>
        </p>
      </td>
    </tr>
  </table>
</body>
</html>`;
}
