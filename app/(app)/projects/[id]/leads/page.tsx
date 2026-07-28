import Link from "next/link";
import { notFound } from "next/navigation";
import { serviceClient } from "@/lib/supabase/service";
import { requireProjectAccess } from "@/lib/lx/currentSite";
import { env } from "@/lib/env";
import { LeadFinder } from "@/components/leads/lead-finder";
import { LeadActions } from "@/components/leads/lead-actions";
import { CampaignPanel, type CampaignSummary } from "@/components/leads/campaign-panel";
import { SenderAddress } from "@/components/leads/sender-address";
import { MailboxConnect, type ConnectedMailbox } from "@/components/leads/mailbox-connect";
import { SeedLogins } from "@/components/leads/seed-logins";
import { listSeedCredentials, type StoredSeedCredential } from "@/lib/outreach/seedCredentials";
import { RefreshLeads } from "@/components/leads/refresh-leads";
import { loadAddressSettings } from "@/lib/outreach/postalAddress";

export const metadata = { title: "Leads" };
export const dynamic = "force-dynamic";

type ProspectRow = {
  target_key: string;
  channel: string;
  status: string;
  score: number | null;
  score_kind: string | null;
  contact_email: string | null;
  contact_source: string | null;
  quote_usd: number | null;
  top_issues: string[] | null;
  report_token: string | null;
  discovery_label: string | null;
  last_sent_at: string | null;
  last_step: number;
};

type SendRow = {
  channel: string;
  step: number;
  recipient: string;
  subject: string | null;
  dry_run: boolean;
  sent_at: string;
};

const STATUS_TONE: Record<string, string> = {
  contacted: "badge-pass",
  replied: "badge-pass",
  won: "badge-pass",
  researched: "badge-warn",
  drafted: "badge-warn",
  new: "badge-unknown",
  skipped: "badge-unknown",
  lost: "badge-fail",
};

export default async function LeadsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: projectId } = await params;
  const access = await requireProjectAccess(projectId, { allowViewer: true });
  if (!access.ok) notFound();

  // The outreach tables have no RLS policies — reads run on the service
  // client after the access check above, the same way the rest of the
  // project pages work. It also keeps outreach_sends unwritable from a
  // browser, so the record of what was sent stays honest.
  const supabase = serviceClient();
  const [{ data: prospectData }, { data: sendData }, { data: campaignData }] = await Promise.all([
    supabase
      .from("outreach_prospects")
      .select(
        "target_key, channel, status, score, score_kind, contact_email, contact_source, quote_usd, top_issues, report_token, discovery_label, last_sent_at, last_step",
      )
      .eq("project_id", projectId)
      .order("updated_at", { ascending: false })
      .limit(200),
    supabase
      .from("outreach_sends")
      .select("channel, step, recipient, subject, dry_run, sent_at")
      .eq("project_id", projectId)
      .order("sent_at", { ascending: false })
      .limit(10),
    supabase
      .from("outreach_campaigns")
      .select("name, active, auto_send, daily_send_limit, max_score, queries, seed_urls, last_run_at, last_run_note")
      .eq("project_id", projectId)
      .order("updated_at", { ascending: false })
      .limit(10),
  ]);

  const prospects = (prospectData as ProspectRow[] | null) ?? [];
  const sends = (sendData as SendRow[] | null) ?? [];
  const campaigns = (campaignData as CampaignSummary[] | null) ?? [];

  const byStatus = new Map<string, number>();
  for (const p of prospects) byStatus.set(p.status, (byStatus.get(p.status) ?? 0) + 1);

  // Leads whose scan may have landed since they were added, plus researched
  // ones we never found an address for — what "Check scans" would work on.
  const pendingCount = prospects.filter(
    (p) => p.channel === "email" && (p.status === "new" || !p.contact_email),
  ).length;

  const since = Date.now() - 24 * 3600 * 1000;
  const liveToday = sends.filter((s) => !s.dry_run && new Date(s.sent_at).getTime() >= since).length;

  // Live sending is gated on having a CAN-SPAM footer address, resolved
  // project → org → account → env.
  const addressSettings = await loadAddressSettings({
    projectId,
    ownerId: access.userId,
  });
  const canSendLive = Boolean(addressSettings.address);

  // The org's default email sender, when it's a connected mailbox rather than
  // an API-key provider — that's what the connect panel reflects back.
  const { data: projectRow } = await supabase
    .from("projects")
    .select("organization_id")
    .eq("id", projectId)
    .maybeSingle();
  const orgId = (projectRow?.organization_id as string | null) ?? null;
  let seedCredentials: StoredSeedCredential[] = [];
  if (orgId) seedCredentials = await listSeedCredentials(orgId);

  // Hosts any campaign in this project is parked on, waiting for a sign-in.
  const waitingHosts = [
    ...new Set(
      campaigns.flatMap((c) =>
        Array.isArray((c as { auth_required_hosts?: string[] }).auth_required_hosts)
          ? ((c as { auth_required_hosts?: string[] }).auth_required_hosts as string[])
          : [],
      ),
    ),
  ];

  let mailbox: ConnectedMailbox | null = null;
  if (orgId) {
    const { data: senderRow } = await supabase
      .from("organization_outreach_configs")
      .select(
        "id, label, from_email, smtp_host, imap_host, discovery_detail, verified_at",
      )
      .eq("organization_id", orgId)
      .eq("channel", "email")
      .eq("provider", "smtp")
      .eq("is_default", true)
      .eq("enabled", true)
      .maybeSingle();
    if (senderRow) {
      const r = senderRow as Record<string, string | null>;
      mailbox = {
        id: r.id as string,
        label: (r.label as string) ?? "",
        fromEmail: r.from_email,
        smtpHost: r.smtp_host,
        imapHost: r.imap_host,
        discoveryDetail: r.discovery_detail,
        verifiedAt: r.verified_at,
      };
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Leads</h1>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          Find businesses, scan their sites, and pitch the fix on behalf of this project — every
          email opens with something the scan actually found, linked to a report they can check.
        </p>
      </div>

      <SenderAddress projectId={projectId} settings={addressSettings} />

      <MailboxConnect projectId={projectId} connected={mailbox} />

      <LeadFinder projectId={projectId} />

      <CampaignPanel projectId={projectId} campaigns={campaigns} canSendLive={canSendLive} />

      <SeedLogins
        projectId={projectId}
        waitingHosts={waitingHosts}
        credentials={seedCredentials}
      />

      <section className="card p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-lg font-semibold">Pipeline</h2>
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-sm text-[var(--color-muted)]">
              {[...byStatus.entries()].map(([s, n]) => `${n} ${s}`).join(" · ") || "no leads yet"} ·{" "}
              {liveToday}/{env.outreachDailyCap} sent today
            </p>
            <RefreshLeads projectId={projectId} pendingCount={pendingCount} />
          </div>
        </div>

        {prospects.length === 0 ? (
          <p className="mt-4 text-sm text-[var(--color-muted)]">
            Nothing yet. Search for businesses above, or set up a campaign to keep the funnel full on
            its own.
          </p>
        ) : (
          <ul className="mt-4 divide-y divide-[var(--color-border)]">
            {prospects.map((p) => {
              const isSlop = p.score_kind === "slop";
              return (
                <li key={`${p.channel}:${p.target_key}`} className="flex flex-wrap items-start justify-between gap-4 py-4">
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2 font-medium">
                      {p.channel === "reddit" ? `u/${p.target_key}` : p.target_key}
                      <span className={`badge ${STATUS_TONE[p.status] ?? "badge-unknown"}`}>{p.status}</span>
                      {p.score !== null && (
                        <span className="font-mono text-xs text-[var(--color-muted)]">
                          {p.score}/100 {isSlop ? "slop" : "AEO"}
                        </span>
                      )}
                      {p.quote_usd ? (
                        <span className="text-xs text-[var(--color-muted)]">fix ≈ ${p.quote_usd}</span>
                      ) : null}
                    </p>

                    <p className="mt-1 text-xs text-[var(--color-muted)]">
                      {p.contact_email ? (
                        <>
                          {p.contact_email}
                          {p.contact_source === "manual" ? " (manual)" : ""}
                        </>
                      ) : (
                        "no contact address found"
                      )}
                      {p.discovery_label ? ` · found as “${p.discovery_label}”` : ""}
                      {p.last_sent_at
                        ? ` · step ${p.last_step} on ${p.last_sent_at.slice(0, 10)}`
                        : ""}
                    </p>

                    {p.top_issues && p.top_issues.length > 0 && (
                      <ul className="mt-2 list-inside list-disc text-xs text-[var(--color-muted)]">
                        {p.top_issues.slice(0, 3).map((issue) => (
                          <li key={issue}>{issue}</li>
                        ))}
                      </ul>
                    )}

                    {p.report_token && (
                      <Link
                        href={`/r/${p.report_token}`}
                        className="mt-2 inline-block text-xs underline"
                        target="_blank"
                      >
                        View report ↗
                      </Link>
                    )}
                  </div>

                  {p.channel === "email" && (
                    <LeadActions
                      projectId={projectId}
                      host={p.target_key}
                      hasContact={Boolean(p.contact_email)}
                      nextStep={Math.min((p.last_step ?? 0) + 1, 3)}
                    />
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {sends.length > 0 && (
        <section className="card p-4">
          <h2 className="text-lg font-semibold">Recent sends</h2>
          <ul className="mt-3 space-y-1 font-mono text-xs text-[var(--color-muted)]">
            {sends.map((s, i) => (
              <li key={`${s.sent_at}-${i}`}>
                <span className={s.dry_run ? "" : "text-[var(--color-fg)]"}>
                  {s.dry_run ? "· dry " : "✓ live"}
                </span>{" "}
                {s.sent_at.slice(0, 16).replace("T", " ")} {s.channel} step {s.step} → {s.recipient}
                {s.subject ? ` — ${s.subject}` : ""}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
