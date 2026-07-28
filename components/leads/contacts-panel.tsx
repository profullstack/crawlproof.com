import type { NicheCount } from "@/lib/outreach/contactsExport";

/**
 * The contact list, as an asset rather than a table.
 *
 * Contacts are org-scoped and outlive any single campaign — the same person
 * found by two projects is one record. That is the whole reason the table is
 * separate from prospects, and until now it had no surface at all, so the
 * durable thing the pipeline was building could not be seen or taken away.
 *
 * Segment sizes rather than a single total, because how many of a kind you
 * have is what decides whether a list is worth anything.
 */
export function ContactsPanel({
  projectId,
  total,
  withEmail,
  niches,
}: {
  projectId: string;
  total: number;
  withEmail: number;
  niches: NicheCount[];
}) {
  if (total === 0) return null;

  return (
    <section className="card p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold">Contacts</h2>
          <p className="text-sm text-[var(--color-muted)]">
            Everyone this organization has found, deduplicated across every campaign and project.{" "}
            {withEmail} of {total} have an address.
          </p>
        </div>
        <a href={`/api/projects/${projectId}/contacts.csv`} className="btn text-sm" download>
          Export CSV
        </a>
      </div>

      <ul className="mt-3 flex flex-wrap gap-2">
        {niches.map((n) => (
          <li
            key={n.niche}
            className="rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-sm"
          >
            {n.niche === "unsorted" ? (
              <span className="text-[var(--color-muted)]">unsorted</span>
            ) : (
              n.niche
            )}{" "}
            <span className="font-mono text-xs text-[var(--color-muted)]">
              {n.withEmail}/{n.contacts}
            </span>
          </li>
        ))}
      </ul>

      <p className="mt-3 text-xs text-[var(--color-muted)]">
        Niche comes from the campaign that found them. Anyone who asked not to be contacted is
        excluded from both the counts and the export.
      </p>
    </section>
  );
}
