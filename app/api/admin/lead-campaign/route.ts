import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { serviceClient } from "@/lib/supabase/service";
import { buildShareCard } from "@/lib/audit/share-card";
import { leadCampaignEmailHtml, sendMarketingEmail } from "@/lib/email";
import { recordLead } from "@/lib/marketing";
import {
  campaignSubject,
  hireUrlFor,
  isStrongScore,
  selectRecipients,
  type LeadRow,
  type Segment,
} from "@/lib/leadCampaign";
import { env } from "@/lib/env";

export const runtime = "nodejs";
export const maxDuration = 300;

// Identifies this campaign in campaign_sends. Bump it to deliberately mail a
// previously-contacted audience again.
const CAMPAIGN_ID = "lead-reengagement-2026-07";

// One-off re-engagement of people who ran a scan and asked for the PDF.
//
// Why this exists rather than /api/admin/email-broadcast: that route selects
// from `profiles`, so it cannot reach a lead who never registered, and it
// sends raw HTML through sendBulk with no unsubscribe footer and no
// List-Unsubscribe headers. This one goes through sendMarketingEmail, which
// adds both, and it filters on unsubscribed_at.
//
// DRY RUN BY DEFAULT. You must pass {"dryRun": false} to actually send.

async function checkAdmin(): Promise<{ ok: true } | { ok: false; response: NextResponse }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { ok: false, response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  const { data: me } = await supabase
    .from("profiles")
    .select("is_admin")
    .eq("id", user.id)
    .maybeSingle();
  if (!me?.is_admin) {
    return { ok: false, response: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }
  return { ok: true };
}

async function loadAudience(): Promise<LeadRow[]> {
  const svc = serviceClient();

  // Every completed scan that captured an email, newest first — the first row
  // per address therefore carries their most recent report.
  const { data: audits } = await svc
    .from("audits")
    .select("pdf_email, target_url, share_token, status, score, engine, summary, id, completed_at")
    .not("pdf_email", "is", null)
    .eq("status", "complete")
    .order("completed_at", { ascending: false })
    .limit(2000);

  const rows = (audits ?? []) as Array<Record<string, unknown>>;
  const emails = Array.from(
    new Set(rows.map((r) => String(r.pdf_email ?? "").trim().toLowerCase()).filter(Boolean)),
  );
  if (emails.length === 0) return [];

  const [{ data: contacts }, { data: profiles }, { data: alreadySent }] = await Promise.all([
    svc.from("marketing_contacts").select("email, unsubscribed_at, consented_at").in("email", emails),
    svc.from("profiles").select("email").in("email", emails),
    svc.from("campaign_sends").select("email").eq("campaign", CAMPAIGN_ID),
  ]);
  const sentAlready = new Set(
    (alreadySent ?? []).map((r) => String(r.email ?? "").trim().toLowerCase()),
  );

  const contactByEmail = new Map(
    (contacts ?? []).map((c) => [String(c.email).toLowerCase(), c]),
  );
  const customerEmails = new Set(
    (profiles ?? []).map((p) => String(p.email ?? "").toLowerCase()),
  );

  // Top findings for the most recent report per address.
  const firstAuditIdByEmail = new Map<string, string>();
  for (const r of rows) {
    const e = String(r.pdf_email ?? "").trim().toLowerCase();
    if (e && !firstAuditIdByEmail.has(e)) firstAuditIdByEmail.set(e, String(r.id));
  }
  const { data: findings } = await svc
    .from("audit_findings")
    .select("audit_id, title, status, priority")
    .in("audit_id", Array.from(firstAuditIdByEmail.values()))
    .in("status", ["fail", "warn"])
    .order("priority", { ascending: true });

  const issuesByAudit = new Map<string, string[]>();
  for (const f of (findings ?? []) as Array<{ audit_id: string; title: string }>) {
    const list = issuesByAudit.get(f.audit_id) ?? [];
    if (list.length < 3) list.push(f.title);
    issuesByAudit.set(f.audit_id, list);
  }

  const out: LeadRow[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const email = String(r.pdf_email ?? "").trim().toLowerCase();
    if (!email || seen.has(email)) continue;
    seen.add(email);

    const card = buildShareCard(r as Parameters<typeof buildShareCard>[0]);
    const contact = contactByEmail.get(email);
    out.push({
      email,
      host: card.host,
      reportToken: (r.share_token as string | null) ?? null,
      score: card.score,
      scoreLabel: card.label,
      kind: card.kind,
      scaleHint: card.scaleHint,
      topIssues: issuesByAudit.get(String(r.id)) ?? [],
      isCustomer: customerEmails.has(email),
      unsubscribedAt: (contact?.unsubscribed_at as string | null) ?? null,
      consentedAt: (contact?.consented_at as string | null) ?? null,
      alreadySent: sentAlready.has(email),
    });
  }
  return out;
}

export async function GET(req: NextRequest) {
  const auth = await checkAdmin();
  if (!auth.ok) return auth.response;

  const segment = (req.nextUrl.searchParams.get("segment") ?? "all") as Segment;
  const audience = await loadAudience();
  const { send, excluded } = selectRecipients(audience, segment);

  const byReason: Record<string, number> = {};
  for (const e of excluded) byReason[e.reason] = (byReason[e.reason] ?? 0) + 1;

  return NextResponse.json({
    segment,
    wouldSend: send.length,
    excluded: byReason,
    customers: send.filter((r) => r.isCustomer).length,
    coldLeads: send.filter((r) => !r.isCustomer).length,
    sample: send.slice(0, 5).map((r) => ({
      email: r.email,
      host: r.host,
      score: r.score,
      subject: campaignSubject(r),
      topIssues: r.topIssues,
    })),
  });
}

export async function POST(req: NextRequest) {
  const auth = await checkAdmin();
  if (!auth.ok) return auth.response;

  let body: { segment?: Segment; dryRun?: boolean; limit?: number; testTo?: string } = {};
  try {
    body = await req.json();
  } catch {
    /* empty body = dry run over everything */
  }

  const segment: Segment = body.segment ?? "all";
  // Opt IN to sending. An accidental POST must never mail 100 people.
  const dryRun = body.dryRun !== false;
  const limit = Math.max(1, Math.min(body.limit ?? 500, 500));

  const audience = await loadAudience();
  const { send } = selectRecipients(audience, segment);
  const batch = send.slice(0, limit);

  if (dryRun) {
    return NextResponse.json({
      dryRun: true,
      segment,
      wouldSend: batch.length,
      recipients: batch.map((r) => r.email),
    });
  }

  const svc = serviceClient();
  const base = env.siteUrl.replace(/\/$/, "");
  let sent = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const row of batch) {
    // A send-to-one override so the whole campaign can be previewed in a real
    // inbox before it goes out.
    const to = body.testTo || row.email;

    // Every recipient needs a marketing_contacts row, because that is where
    // the unsubscribe token lives. recordLead is a no-op if one exists and
    // never upgrades consent.
    await recordLead({ email: row.email, source: "lead-campaign" });
    const { data: contact } = await svc
      .from("marketing_contacts")
      .select("unsubscribe_token, unsubscribed_at")
      .ilike("email", row.email)
      .maybeSingle();

    // Re-check immediately before sending: the audience was selected earlier
    // in this request and somebody may have unsubscribed in between.
    if (!contact?.unsubscribe_token || contact.unsubscribed_at) {
      failed++;
      errors.push(`${row.email}: no token or unsubscribed`);
      continue;
    }

    const res = await sendMarketingEmail({
      to,
      subject: campaignSubject(row),
      html: leadCampaignEmailHtml({
        host: row.host,
        scoreLabel: row.scoreLabel,
        score: row.score,
        scaleHint: row.scaleHint,
        topIssues: row.topIssues,
        reportUrl: `${base}/r/${row.reportToken}`,
        hireUrl: hireUrlFor(row, base),
        isCustomer: row.isCustomer,
        strong: isStrongScore(row),
      }),
      unsubscribeToken: contact.unsubscribe_token as string,
    });

    if (res.sent) {
      sent++;
      // Log AFTER a confirmed send. Logging first would suppress a retry of a
      // message that never actually went out.
      if (!body.testTo) {
        await svc.from("campaign_sends").insert({
          campaign: CAMPAIGN_ID,
          email: row.email,
          subject: campaignSubject(row),
        });
      }
    } else {
      failed++;
      if (errors.length < 10) errors.push(`${row.email}: ${res.error}`);
    }

    // Paced so a burst doesn't trip the provider's rate limit or look like a
    // spam cannon to receiving domains.
    await new Promise((r) => setTimeout(r, 400));
    if (body.testTo) break;
  }

  console.log(`[admin/lead-campaign] segment=${segment} sent=${sent} failed=${failed}`);
  return NextResponse.json({ dryRun: false, segment, sent, failed, errors });
}
