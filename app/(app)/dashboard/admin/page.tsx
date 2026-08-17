import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { serviceClient } from "@/lib/supabase/service";
import Link from "next/link";
import { GrantCreditsForm, Vu1nzIntegrationForm } from "./form";
import { IntegrationsManager } from "./integrations-form";
import { env } from "@/lib/env";
import { getVu1nzIntegrationStatus } from "@/lib/platform-integrations";
import { ProviderCostsPanel } from "./provider-costs-panel";

export const metadata = {
  title: "Admin · Crawlproof",
  robots: { index: false, follow: false },
};

type GrantRow = {
  id: string;
  recipient_email: string;
  credits: number;
  reason: string | null;
  created_at: string;
  granted_by_email: string | null;
};

export default async function AdminPage() {
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
  // 404 (not redirect) so a non-admin who guesses the URL doesn't get
  // confirmation that the page exists.
  if (!me?.is_admin) notFound();

  // Recent grants — admins see everything; loaded via service client
  // so we get the granted_by email join cheaply.
  const svc = serviceClient();
  const [{ data: recentRaw }, { data: integrationsRaw }, vu1nzIntegration] = await Promise.all([
    svc
      .from("admin_credit_grants")
      .select(
        "id, recipient_email, credits, reason, created_at, granted_by:profiles!admin_credit_grants_granted_by_fkey(email)",
      )
      .order("created_at", { ascending: false })
      .limit(20),
    svc
      .from("autoblog_integrations")
      .select(
        "id, name, kind, access_token, created_at, last_used_at, request_count",
      )
      .order("created_at", { ascending: false }),
    getVu1nzIntegrationStatus(),
  ]);
  const recent: GrantRow[] = (recentRaw ?? []).map((r: any) => ({
    id: r.id,
    recipient_email: r.recipient_email,
    credits: r.credits,
    reason: r.reason,
    created_at: r.created_at,
    granted_by_email: r.granted_by?.email ?? null,
  }));

  return (
    <div className="mx-auto max-w-2xl space-y-8">
      <div>
        <h1 className="text-3xl font-bold">Admin</h1>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          Grant or remove credits by email. Every grant is logged in{" "}
          <code>admin_credit_grants</code>.
        </p>
      </div>

      {/* Spend is checked before anything else on this page. A drained provider
          silently breaks audit engines, and previously the only way to notice
          was opening three vendor dashboards. */}
      <section className="card p-5">
        <ProviderCostsPanel />
      </section>

      {/* Sits above every tool on this page: it is the only read surface for
          captured leads, campaign sends, and watches, and a text link under the
          heading was too easy to miss. */}
      <section className="card p-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold">Leads &amp; campaigns</h2>
            <p className="mt-1 text-sm text-[var(--color-muted)]">
              Captured leads and their status, outbound campaign sends, watched
              URLs, and live audience counts per segment.
            </p>
          </div>
          <a href="/dashboard/admin/leads" className="btn btn-primary whitespace-nowrap">
            Open leads dashboard →
          </a>
        </div>
      </section>

      <section className="card p-5">
        <h2 className="text-lg font-semibold">Grant credits</h2>
        <GrantCreditsForm />
      </section>

      <section className="card p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <h2 className="text-lg font-semibold">GitHub App</h2>
            <p className="mt-1 text-sm text-[var(--color-muted)]">
              One-time platform setup. Registers CrawlProof as a GitHub
              App on the profullstack org via the App Manifest flow, then
              hands you the env vars to paste into Railway. Users install
              the App from their own settings page after the env is set.
            </p>
          </div>
          <Link href="/dashboard/admin/github/setup" className="btn btn-primary text-sm">
            {env.githubAppId ? "Re-register App" : "Register App"}
          </Link>
        </div>
        {env.githubAppId && (
          <p className="mt-3 text-xs text-[var(--color-muted)]">
            Currently configured: app id <code>{env.githubAppId}</code>,
            slug <code>{env.githubAppSlug || "(unset)"}</code>. Re-registering
            creates a new App; the old one stays on GitHub until you
            delete it there.
          </p>
        )}
      </section>

      <section className="card p-5">
        <h2 className="text-lg font-semibold">Email broadcast</h2>
        <p className="mt-1 text-sm text-[var(--color-muted)]">Send a mass email to all registered users.</p>
        <div className="mt-4">
          <Link href="/dashboard/admin/email-broadcast" className="text-sm font-semibold underline hover:opacity-80">
            Compose &amp; send →
          </Link>
        </div>
      </section>

      <section className="card p-5">
        <h2 className="text-lg font-semibold">Vu1nz scanner</h2>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          Platform API token for the Vu1nz website scanner engine. The token is
          encrypted at rest and used by background scans.
        </p>
        <Vu1nzIntegrationForm {...vu1nzIntegration} />
      </section>

      <section className="card p-5">
        <h2 className="text-lg font-semibold">Autoblog integrations</h2>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          Bearer tokens for inbound autoblog webhooks (Outrank, Crawlproof).
          The bearer doubles as the HMAC secret per the{" "}
          <a className="underline" href="/docs/autoblog-webhook">
            autoblog webhook
          </a>{" "}
          contract.
        </p>
        <div className="mt-4">
          <IntegrationsManager initial={integrationsRaw ?? []} />
        </div>
      </section>

      <section>
        <h2 className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
          Recent grants
        </h2>
        {recent.length === 0 ? (
          <p className="mt-2 text-sm text-[var(--color-muted)]">No grants yet.</p>
        ) : (
          <table className="mt-2 w-full text-left text-sm">
            <thead className="border-b border-[var(--color-border)] text-xs uppercase tracking-wider text-[var(--color-muted)]">
              <tr>
                <th className="py-2 pr-4">When</th>
                <th className="py-2 pr-4">Recipient</th>
                <th className="py-2 pr-4 text-right">±Credits</th>
                <th className="py-2 pr-4">By</th>
                <th className="py-2">Reason</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border)]">
              {recent.map((g) => (
                <tr key={g.id} className="align-top">
                  <td className="py-2 pr-4 text-xs text-[var(--color-muted)]">
                    {new Date(g.created_at).toLocaleString()}
                  </td>
                  <td className="py-2 pr-4">{g.recipient_email}</td>
                  <td className="py-2 pr-4 text-right tabular-nums">
                    <span
                      className={
                        g.credits >= 0
                          ? "text-[var(--color-pass)]"
                          : "text-[var(--color-fail)]"
                      }
                    >
                      {g.credits >= 0 ? "+" : ""}
                      {g.credits}
                    </span>
                  </td>
                  <td className="py-2 pr-4 text-xs text-[var(--color-muted)]">
                    {g.granted_by_email ?? "—"}
                  </td>
                  <td className="py-2 text-sm">{g.reason ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
