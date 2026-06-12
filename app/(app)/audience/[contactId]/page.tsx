import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export const metadata = { title: "Audience · Contact" };

// Contact detail (PRD §15): identity graph, project memberships, event
// timeline, and consent history for one deduped contact. RLS guarantees the
// caller owns the contact's scope.

type Contact = {
  id: string;
  email: string;
  name: string | null;
  status: string;
  marketing_consent: boolean;
  unsubscribed_at: string | null;
  suppressed_at: string | null;
  suppression_reason: string | null;
  source_project_id: string | null;
  first_seen_at: string;
  last_seen_at: string;
  first_url: string | null;
  first_referrer: string | null;
  first_utm_source: string | null;
  first_utm_medium: string | null;
  first_utm_campaign: string | null;
  last_url: string | null;
  last_utm_source: string | null;
  last_utm_campaign: string | null;
  tags: string[] | null;
  metadata: Record<string, unknown> | null;
};

function fmt(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export default async function ContactDetailPage({
  params,
}: {
  params: Promise<{ contactId: string }>;
}) {
  const { contactId } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: contactRow } = await supabase
    .from("audience_contacts")
    .select(
      "id, email, name, status, marketing_consent, unsubscribed_at, suppressed_at, suppression_reason, source_project_id, first_seen_at, last_seen_at, first_url, first_referrer, first_utm_source, first_utm_medium, first_utm_campaign, last_url, last_utm_source, last_utm_campaign, tags, metadata",
    )
    .eq("id", contactId)
    .maybeSingle();
  if (!contactRow) notFound();
  const contact = contactRow as Contact;

  const [{ data: identities }, { data: links }, { data: events }, { data: consents }] =
    await Promise.all([
      supabase
        .from("audience_identities")
        .select("id, provider, external_id, project_id, created_at")
        .eq("contact_id", contactId)
        .order("created_at", { ascending: true }),
      supabase
        .from("audience_project_links")
        .select("id, project_id, external_user_id, role, plan, first_seen_at, last_seen_at")
        .eq("contact_id", contactId),
      supabase
        .from("audience_events")
        .select("id, project_id, event, source, url, utm_source, utm_campaign, occurred_at")
        .eq("contact_id", contactId)
        .order("occurred_at", { ascending: false })
        .limit(50),
      supabase
        .from("audience_consent_events")
        .select("id, consent_type, consent_value, source, occurred_at")
        .eq("contact_id", contactId)
        .order("occurred_at", { ascending: false })
        .limit(20),
    ]);

  // Resolve project names for the ids we reference.
  const projectIds = [
    ...new Set(
      [
        ...(links ?? []).map((l) => l.project_id as string),
        ...(events ?? []).map((e) => e.project_id as string),
        contact.source_project_id,
      ].filter(Boolean) as string[],
    ),
  ];
  const projectNames = new Map<string, string>();
  if (projectIds.length > 0) {
    const { data: projects } = await supabase
      .from("projects")
      .select("id, name")
      .in("id", projectIds);
    for (const p of projects ?? []) projectNames.set(p.id as string, p.name as string);
  }
  const projectLabel = (id: string | null) =>
    (id && projectNames.get(id)) || (id ? `${id.slice(0, 8)}…` : "—");

  const attribution: [string, string | null][] = [
    ["First seen", fmt(contact.first_seen_at)],
    ["Last seen", fmt(contact.last_seen_at)],
    ["First URL", contact.first_url],
    ["First referrer", contact.first_referrer],
    ["First UTM", [contact.first_utm_source, contact.first_utm_medium, contact.first_utm_campaign].filter(Boolean).join(" / ") || null],
    ["Last URL", contact.last_url],
    ["Last UTM", [contact.last_utm_source, contact.last_utm_campaign].filter(Boolean).join(" / ") || null],
    ["Source project", contact.source_project_id ? projectLabel(contact.source_project_id) : null],
  ];

  return (
    <div className="space-y-8">
      <div>
        <Link href="/audience" className="text-sm text-[var(--color-muted)]">
          ← Audience Hub
        </Link>
        <h1 className="mt-3 break-all text-3xl font-bold">{contact.email}</h1>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
          {contact.name && <span>{contact.name}</span>}
          <span className="badge badge-warn">{contact.status}</span>
          {contact.suppressed_at ? (
            <span className="badge badge-fail">
              suppressed{contact.suppression_reason ? ` · ${contact.suppression_reason}` : ""}
            </span>
          ) : contact.unsubscribed_at ? (
            <span className="badge badge-fail">unsubscribed {fmt(contact.unsubscribed_at)}</span>
          ) : (
            <span className={`badge ${contact.marketing_consent ? "badge-pass" : "badge-warn"}`}>
              {contact.marketing_consent ? "marketing consent" : "no marketing consent"}
            </span>
          )}
          {(contact.tags ?? []).map((tag) => (
            <span key={tag} className="badge">{tag}</span>
          ))}
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="card p-5">
          <h2 className="text-lg font-semibold">Attribution</h2>
          <dl className="mt-3 space-y-2 text-sm">
            {attribution.map(([label, value]) => (
              <div key={label} className="flex gap-3">
                <dt className="w-32 shrink-0 text-[var(--color-muted)]">{label}</dt>
                <dd className="break-all">{value ?? "—"}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="card p-5">
          <h2 className="text-lg font-semibold">Projects</h2>
          {(links ?? []).length === 0 ? (
            <p className="mt-3 text-sm text-[var(--color-muted)]">No project links yet.</p>
          ) : (
            <ul className="mt-3 space-y-2 text-sm">
              {(links ?? []).map((link) => (
                <li key={link.id as string} className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{projectLabel(link.project_id as string)}</span>
                  {link.plan ? <span className="badge">{String(link.plan)}</span> : null}
                  {link.role ? <span className="badge">{String(link.role)}</span> : null}
                  {link.external_user_id ? (
                    <code className="text-xs text-[var(--color-muted)]">
                      {String(link.external_user_id)}
                    </code>
                  ) : null}
                  <span className="text-xs text-[var(--color-muted)]">
                    last seen {fmt(link.last_seen_at as string)}
                  </span>
                </li>
              ))}
            </ul>
          )}

          <h2 className="mt-6 text-lg font-semibold">Identities</h2>
          {(identities ?? []).length === 0 ? (
            <p className="mt-3 text-sm text-[var(--color-muted)]">No linked identities.</p>
          ) : (
            <ul className="mt-3 space-y-1.5 text-sm">
              {(identities ?? []).map((identity) => (
                <li key={identity.id as string} className="flex items-center gap-2">
                  <span className="badge">{String(identity.provider)}</span>
                  <code className="break-all text-xs">{String(identity.external_id)}</code>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <section className="card p-5">
        <h2 className="text-lg font-semibold">Event timeline</h2>
        {(events ?? []).length === 0 ? (
          <p className="mt-3 text-sm text-[var(--color-muted)]">No events recorded.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--color-border)] text-left text-xs uppercase tracking-wider text-[var(--color-muted)]">
                  <th className="py-2 pr-4">Event</th>
                  <th className="py-2 pr-4">Project</th>
                  <th className="py-2 pr-4">Source</th>
                  <th className="py-2 pr-4">Campaign</th>
                  <th className="py-2">When</th>
                </tr>
              </thead>
              <tbody>
                {(events ?? []).map((event) => (
                  <tr key={event.id as string} className="border-b border-[var(--color-border)] last:border-0">
                    <td className="py-2 pr-4 font-mono text-xs">{String(event.event)}</td>
                    <td className="py-2 pr-4">{projectLabel(event.project_id as string)}</td>
                    <td className="py-2 pr-4">{String(event.source)}</td>
                    <td className="py-2 pr-4 text-[var(--color-muted)]">
                      {[event.utm_source, event.utm_campaign].filter(Boolean).join(" / ") || "—"}
                    </td>
                    <td className="py-2 text-[var(--color-muted)]">{fmt(event.occurred_at as string)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card p-5">
        <h2 className="text-lg font-semibold">Consent history</h2>
        {(consents ?? []).length === 0 ? (
          <p className="mt-3 text-sm text-[var(--color-muted)]">
            No explicit consent events. Consent is only recorded from explicit
            signals — never inferred from account creation.
          </p>
        ) : (
          <ul className="mt-3 space-y-1.5 text-sm">
            {(consents ?? []).map((consent) => (
              <li key={consent.id as string} className="flex flex-wrap items-center gap-2">
                <span className={`badge ${consent.consent_value ? "badge-pass" : "badge-fail"}`}>
                  {consent.consent_value ? "opt-in" : "opt-out"}
                </span>
                <span>{String(consent.consent_type)}</span>
                <span className="text-xs text-[var(--color-muted)]">
                  via {String(consent.source ?? "unknown")} · {fmt(consent.occurred_at as string)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
