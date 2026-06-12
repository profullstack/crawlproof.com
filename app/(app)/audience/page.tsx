import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export const metadata = { title: "Audience Hub" };

// Account-level Audience Hub: every contact captured across the caller's
// properties, deduped by normalized email. RLS scopes all queries to
// contacts the user owns directly or through an organization they own.

type ContactRow = {
  id: string;
  email: string;
  name: string | null;
  status: string;
  marketing_consent: boolean;
  unsubscribed_at: string | null;
  suppressed_at: string | null;
  last_seen_at: string;
  first_utm_source: string | null;
  last_utm_campaign: string | null;
};

const STATUS_BADGE: Record<string, string> = {
  customer: "badge-pass",
  user: "badge-pass",
  subscriber: "badge-pass",
  lead: "badge-warn",
  unknown: "badge-warn",
  unsubscribed: "badge-fail",
  suppressed: "badge-fail",
  deleted: "badge-fail",
};

function fmt(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString();
  } catch {
    return iso;
  }
}

export default async function AudienceHubPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const head = { count: "exact" as const, head: true };
  const [totalRes, consentedRes, usersRes, customersRes, unsubscribedRes] =
    await Promise.all([
      supabase.from("audience_contacts").select("id", head),
      supabase
        .from("audience_contacts")
        .select("id", head)
        .eq("marketing_consent", true)
        .is("unsubscribed_at", null)
        .is("suppressed_at", null),
      supabase.from("audience_contacts").select("id", head).eq("status", "user"),
      supabase.from("audience_contacts").select("id", head).eq("status", "customer"),
      supabase
        .from("audience_contacts")
        .select("id", head)
        .in("status", ["unsubscribed", "suppressed", "deleted"]),
    ]);
  const total = totalRes.count ?? 0;
  const consented = consentedRes.count ?? 0;
  const users = usersRes.count ?? 0;
  const customers = customersRes.count ?? 0;
  const unsubscribed = unsubscribedRes.count ?? 0;

  let contactsQuery = supabase
    .from("audience_contacts")
    .select(
      "id, email, name, status, marketing_consent, unsubscribed_at, suppressed_at, last_seen_at, first_utm_source, last_utm_campaign",
    )
    .order("last_seen_at", { ascending: false })
    .limit(100);
  if (q?.trim()) {
    contactsQuery = contactsQuery.ilike("normalized_email", `%${q.trim().toLowerCase()}%`);
  }
  const { data } = await contactsQuery;
  const contacts = (data ?? []) as ContactRow[];

  const cards: { label: string; value: number }[] = [
    { label: "Contacts", value: total },
    { label: "Marketing consent", value: consented },
    { label: "Users", value: users },
    { label: "Customers", value: customers },
    { label: "Unsubscribed / suppressed", value: unsubscribed },
  ];

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold">Audience Hub</h1>
          <p className="mt-2 max-w-2xl text-[var(--color-muted)]">
            One deduplicated, consent-aware contact list across all your
            connected properties. Capture leads via <code>stats.js</code>,
            confirm lifecycle events server-side, export when you need to send.
          </p>
        </div>
        <div className="flex gap-2">
          <a href="/api/audience/export" className="btn">
            Export CSV
          </a>
          <a href="/api/audience/export?consented=1" className="btn btn-primary">
            Export consented
          </a>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {cards.map((card) => (
          <div key={card.label} className="card p-4">
            <div className="text-2xl font-bold">{card.value}</div>
            <div className="mt-1 text-xs uppercase tracking-wider text-[var(--color-muted)]">
              {card.label}
            </div>
          </div>
        ))}
      </div>

      <section className="space-y-3">
        <form className="flex max-w-md gap-2" action="/audience" method="GET">
          <input
            type="search"
            name="q"
            defaultValue={q ?? ""}
            placeholder="Search by email…"
            className="input"
          />
          <button type="submit" className="btn">
            Search
          </button>
        </form>

        {contacts.length === 0 ? (
          <div className="card p-6 text-[var(--color-muted)]">
            {q
              ? "No contacts match that search."
              : "No contacts yet. Install the Audience Hub on a project (Project → Audience tab) and identify users or capture leads via stats.js."}
          </div>
        ) : (
          <div className="card overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--color-border)] text-left text-xs uppercase tracking-wider text-[var(--color-muted)]">
                  <th className="px-4 py-3">Email</th>
                  <th className="px-4 py-3">Name</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Consent</th>
                  <th className="px-4 py-3">First source</th>
                  <th className="px-4 py-3">Last seen</th>
                </tr>
              </thead>
              <tbody>
                {contacts.map((contact) => (
                  <tr
                    key={contact.id}
                    className="border-b border-[var(--color-border)] last:border-0"
                  >
                    <td className="px-4 py-2.5">
                      <Link
                        href={`/audience/${contact.id}`}
                        className="font-medium hover:underline"
                      >
                        {contact.email}
                      </Link>
                    </td>
                    <td className="px-4 py-2.5">{contact.name ?? "—"}</td>
                    <td className="px-4 py-2.5">
                      <span className={`badge ${STATUS_BADGE[contact.status] ?? "badge-warn"}`}>
                        {contact.status}
                      </span>
                    </td>
                    <td className="px-4 py-2.5">
                      {contact.suppressed_at
                        ? "suppressed"
                        : contact.unsubscribed_at
                          ? "unsubscribed"
                          : contact.marketing_consent
                            ? "yes"
                            : "no"}
                    </td>
                    <td className="px-4 py-2.5 text-[var(--color-muted)]">
                      {contact.first_utm_source ?? contact.last_utm_campaign ?? "—"}
                    </td>
                    <td className="px-4 py-2.5 text-[var(--color-muted)]">
                      {fmt(contact.last_seen_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
