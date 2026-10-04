import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { serviceClient } from "@/lib/supabase/service";
import { listActors } from "@/lib/tracker/actorStore";
import { DECLARED_DEFINITION } from "@/lib/tracker/actors";
import { ActorsPanel } from "./panel";

export const metadata = { title: "Declared actors" };
export const dynamic = "force-dynamic";

export default async function ActorsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const sb = serviceClient();
  const [res, { data: projects }] = await Promise.all([
    listActors(sb, user!.id),
    // The sites a browser declaration links to: yours, with the tracker on.
    sb
      .from("projects")
      .select("id, name, url")
      .eq("owner_id", user!.id)
      .eq("tracker_enabled", true)
      .order("name", { ascending: true }),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <Link href="/dashboard/settings" className="text-sm text-[var(--color-muted)]">
          ← Settings
        </Link>
        <h1 className="mt-1 text-3xl font-bold">Declared actors</h1>
        <p className="mt-2 max-w-2xl text-sm text-[var(--color-muted)]">
          Say who you are, and whether you are a person or an agent, on every site running the
          CrawlProof tracker. {DECLARED_DEFINITION} Names are visible to you only unless you make an
          actor public; other site owners see counts.
        </p>
      </div>
      {res.ok ? (
        <ActorsPanel
          initial={res.value}
          sites={((projects ?? []) as { id: string; name: string; url: string }[]).filter((p) => p.url)}
        />
      ) : (
        <div className="card p-5 text-sm text-[var(--color-fail)]">
          Could not load actors: {res.error}
        </div>
      )}
    </div>
  );
}
