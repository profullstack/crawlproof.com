import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { serviceClient } from "@/lib/supabase/service";
import { GrantCreditsForm } from "./form";

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
  const { data: recentRaw } = await svc
    .from("admin_credit_grants")
    .select(
      "id, recipient_email, credits, reason, created_at, granted_by:profiles!admin_credit_grants_granted_by_fkey(email)",
    )
    .order("created_at", { ascending: false })
    .limit(20);
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

      <section className="card p-5">
        <h2 className="text-lg font-semibold">Grant credits</h2>
        <GrantCreditsForm />
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
