import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { env } from "@/lib/env";
import { SlotManager } from "@/components/ads/slot-manager";

export const metadata = { title: "Monetize your site" };

type Project = { id: string; name: string; url: string };
type Slot = {
  id: string;
  project_id: string;
  status: string;
  payout_address: string | null;
  payout_currency: string | null;
};

export default async function SlotsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  let projects: Project[] = [];
  let slots: Slot[] = [];
  if (user) {
    const [{ data: p }, { data: s }] = await Promise.all([
      supabase.from("projects").select("id, name, url").order("created_at", { ascending: false }),
      supabase.from("ad_slots").select("id, project_id, status, payout_address, payout_currency"),
    ]);
    projects = (p as Project[]) ?? [];
    slots = (s as Slot[]) ?? [];
  }

  const slotByProject = new Map(slots.map((s) => [s.project_id, s]));

  return (
    <div className="mx-auto max-w-3xl">
      <Link href="/ads" className="text-sm text-[var(--color-muted)]">
        ← Ad campaigns
      </Link>
      <h1 className="mt-4 text-3xl font-bold">Monetize your site</h1>
      <p className="mt-2 text-[var(--color-muted)]">
        Show CrawlProof network ads on your site and earn crypto for the clicks. Opt a
        project in, drop one tag on your page, and add a payout wallet.
      </p>

      {projects.length === 0 ? (
        <div className="card mt-6 p-8 text-center text-[var(--color-muted)]">
          You have no projects yet.{" "}
          <Link href="/projects/new" className="text-[var(--color-accent)]">
            Create one
          </Link>{" "}
          to enable a slot.
        </div>
      ) : (
        <ul className="mt-6 space-y-3">
          {projects.map((p) => (
            <SlotManager
              key={p.id}
              project={p}
              slot={slotByProject.get(p.id) ?? null}
              origin={env.siteUrl}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
