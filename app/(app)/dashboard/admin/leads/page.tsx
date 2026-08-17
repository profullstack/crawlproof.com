import Link from "next/link";
import { redirect, notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { serviceClient } from "@/lib/supabase/service";
import { buildShareCard } from "@/lib/audit/share-card";
import {
  selectRecipients,
  type ExclusionReason,
  type LeadRow,
  type Segment,
} from "@/lib/leadCampaign";

export const metadata = { title: "Leads", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

const CAMPAIGN_ID = "lead-reengagement-2026-07";

function fmt(ts: string | null): string {
  if (!ts) return "—";
  return new Date(ts).toISOString().slice(0, 16).replace("T", " ");
}

export default async function AdminLeadsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  const { data: me } = await supabase
    .from("profiles")
    .select("is_admin")
    .eq("id", user.id)
    .maybeSingle();
  // 404 rather than redirect, matching /admin — a non-admin who guesses the
  // URL shouldn't get confirmation the page exists.
  if (!me?.is_admin) notFound();

  const svc = serviceClient();

  const [{ data: auditRows }, { data: sendRows }, { data: watchRows }] = await Promise.all([
    svc
      .from("audits")
      .select("pdf_email, phone, target_url, share_token, status, score, engine, summary, completed_at")
      .not("pdf_email", "is", null)
      .eq("status", "complete")
      .order("completed_at", { ascending: false })
      .limit(2000),
    svc
      .from("campaign_sends")
      .select("email, subject, sent_at, campaign")
      .order("sent_at", { ascending: false })
      .limit(500),
    svc
      .from("scan_watches")
      .select("email, target_url, engine, cadence, last_score, verified_at, unsubscribed_at, last_notified_at, next_run_at")
      .order("created_at", { ascending: false })
      .limit(200),
  ]);

  const sends = sendRows ?? [];
  const sentSet = new Set(sends.map((s) => String(s.email ?? "").toLowerCase()));

  const emails = Array.from(
    new Set(
      (auditRows ?? [])
        .map((r) => String(r.pdf_email ?? "").trim().toLowerCase())
        .filter(Boolean),
    ),
  );

  const [{ data: contacts }, { data: profiles }] = await Promise.all([
    emails.length
      ? svc.from("marketing_contacts").select("email, unsubscribed_at, consented_at").in("email", emails)
      : Promise.resolve({ data: [] as never[] }),
    emails.length
      ? svc.from("profiles").select("email").in("email", emails)
      : Promise.resolve({ data: [] as never[] }),
  ]);
  const cMap = new Map(
    (contacts ?? []).map((c) => [String(c.email).toLowerCase(), c as Record<string, unknown>]),
  );
  const custs = new Set((profiles ?? []).map((p) => String(p.email ?? "").toLowerCase()));

  const seen = new Set<string>();
  const leads: Array<LeadRow & { phone: string | null; scannedAt: string | null }> = [];
  for (const r of (auditRows ?? []) as Array<Record<string, unknown>>) {
    const email = String(r.pdf_email ?? "").trim().toLowerCase();
    if (!email || seen.has(email)) continue;
    seen.add(email);
    const card = buildShareCard(r as Parameters<typeof buildShareCard>[0]);
    const c = cMap.get(email);
    leads.push({
      email,
      host: card.host,
      reportToken: (r.share_token as string | null) ?? null,
      score: card.score,
      scoreLabel: card.label,
      kind: card.kind,
      scaleHint: card.scaleHint,
      topIssues: [],
      isCustomer: custs.has(email),
      unsubscribedAt: (c?.unsubscribed_at as string | null) ?? null,
      consentedAt: (c?.consented_at as string | null) ?? null,
      alreadySent: sentSet.has(email),
      phone: (r.phone as string | null) ?? null,
      scannedAt: (r.completed_at as string | null) ?? null,
    });
  }

  // Same selection the campaign endpoint runs, so this page can't drift from
  // what would actually be sent.
  const bySegment: Record<Segment, { send: number; excluded: Record<string, number> }> =
    {} as never;
  for (const seg of ["all", "users", "leads"] as Segment[]) {
    const { send, excluded } = selectRecipients(leads, seg);
    const counts: Record<string, number> = {};
    for (const e of excluded) counts[e.reason] = (counts[e.reason] ?? 0) + 1;
    bySegment[seg] = { send: send.length, excluded: counts };
  }

  const watches = watchRows ?? [];
  const confirmedWatches = watches.filter((w) => w.verified_at && !w.unsubscribed_at);

  return (
    <main className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
      <div className="flex items-baseline justify-between gap-4">
        <h1 className="text-3xl font-bold">Leads</h1>
        <Link href="/dashboard/admin" className="text-sm text-[var(--color-muted)] hover:underline">
          ← Admin
        </Link>
      </div>

      <div className="mt-6 grid gap-3 sm:grid-cols-4">
        <Stat label="Captured leads" value={leads.length} hint="distinct emails from PDF requests" />
        <Stat label="Campaign sent" value={sends.length} hint={CAMPAIGN_ID} />
        <Stat label="Confirmed watches" value={confirmedWatches.length} hint={`${watches.length} total`} />
        <Stat
          label="Unsubscribed"
          value={leads.filter((l) => l.unsubscribedAt).length}
          hint="honoured on every send"
        />
      </div>

      <Section title="Campaign audience (live, same logic as the sender)">
        <div className="grid gap-3 sm:grid-cols-3">
          {(["all", "users", "leads"] as Segment[]).map((seg) => (
            <div key={seg} className="card p-4">
              <p className="text-xs uppercase tracking-wider text-[var(--color-muted)]">{seg}</p>
              <p className="mt-1 text-2xl font-bold">{bySegment[seg].send}</p>
              <p className="mt-1 text-xs text-[var(--color-muted)]">would send now</p>
              <ul className="mt-2 space-y-0.5 text-xs text-[var(--color-muted)]">
                {Object.entries(bySegment[seg].excluded)
                  .sort((a, b) => b[1] - a[1])
                  .map(([reason, n]) => (
                    <li key={reason}>
                      {reason.replace(/-/g, " ")}: <span className="tabular-nums">{n}</span>
                    </li>
                  ))}
              </ul>
            </div>
          ))}
        </div>
      </Section>

      <Section title={`Sent — ${CAMPAIGN_ID}`}>
        {sends.length === 0 ? (
          <Empty>Nothing sent yet.</Empty>
        ) : (
          <Table head={["Email", "Subject", "Sent"]}>
            {sends.slice(0, 100).map((s, i) => (
              <tr key={`${s.email}-${i}`} className="border-t border-[var(--color-border)]">
                <Td>{String(s.email)}</Td>
                <Td muted>{String(s.subject ?? "—")}</Td>
                <Td muted>{fmt(s.sent_at as string)}</Td>
              </tr>
            ))}
          </Table>
        )}
      </Section>

      <Section title="Watches">
        {watches.length === 0 ? (
          <Empty>No watches yet. They appear once someone confirms the opt-in email.</Empty>
        ) : (
          <Table head={["Email", "Site", "Cadence", "Last score", "Confirmed", "Next run"]}>
            {watches.map((w, i) => (
              <tr key={i} className="border-t border-[var(--color-border)]">
                <Td>{String(w.email)}</Td>
                <Td muted>{String(w.target_url)}</Td>
                <Td muted>
                  {String(w.cadence)} · {String(w.engine)}
                </Td>
                <Td muted>{w.last_score ?? "—"}</Td>
                <Td muted>
                  {w.unsubscribed_at ? "stopped" : w.verified_at ? fmt(w.verified_at as string) : "pending"}
                </Td>
                <Td muted>{fmt(w.next_run_at as string)}</Td>
              </tr>
            ))}
          </Table>
        )}
      </Section>

      <Section title="Captured leads">
        <Table head={["Email", "Phone", "Scanned site", "Score", "Type", "Status"]}>
          {leads.slice(0, 200).map((l) => {
            const status: ExclusionReason | "queued" | "sent" = l.unsubscribedAt
              ? "unsubscribed"
              : l.alreadySent
                ? "sent"
                : (selectRecipients([l], "all").excluded[0]?.reason ?? "queued");
            return (
              <tr key={l.email} className="border-t border-[var(--color-border)]">
                <Td>{l.email}</Td>
                <Td muted>{l.phone ?? "—"}</Td>
                <Td muted>
                  {l.reportToken ? (
                    <a className="hover:underline" href={`/r/${l.reportToken}`} target="_blank" rel="noreferrer">
                      {l.host}
                    </a>
                  ) : (
                    l.host
                  )}
                </Td>
                <Td muted>{l.score ?? "—"}</Td>
                <Td muted>{l.isCustomer ? "user" : "lead"}</Td>
                <Td muted>{String(status).replace(/-/g, " ")}</Td>
              </tr>
            );
          })}
        </Table>
        {leads.length > 200 && (
          <p className="mt-2 text-xs text-[var(--color-muted)]">
            Showing 200 of {leads.length}.
          </p>
        )}
      </Section>
    </main>
  );
}

function Stat({ label, value, hint }: { label: string; value: number; hint?: string }) {
  return (
    <div className="card p-4">
      <p className="text-xs uppercase tracking-wider text-[var(--color-muted)]">{label}</p>
      <p className="mt-1 text-2xl font-bold tabular-nums">{value}</p>
      {hint && <p className="mt-1 text-xs text-[var(--color-muted)]">{hint}</p>}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-10">
      <h2 className="mb-3 text-lg font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="card p-4 text-sm text-[var(--color-muted)]">{children}</div>;
}

function Table({ head, children }: { head: string[]; children: React.ReactNode }) {
  return (
    <div className="card overflow-x-auto p-0">
      <table className="w-full min-w-[40rem] text-sm">
        <thead>
          <tr>
            {head.map((h) => (
              <th
                key={h}
                className="px-3 py-2 text-left text-[11px] uppercase tracking-wider text-[var(--color-muted)]"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

function Td({ children, muted }: { children: React.ReactNode; muted?: boolean }) {
  return (
    <td className={`px-3 py-2 ${muted ? "text-[var(--color-muted)]" : ""}`}>{children}</td>
  );
}
