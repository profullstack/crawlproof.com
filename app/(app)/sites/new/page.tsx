import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { NewSiteForm } from "./form";

export const metadata = { title: "Add a site" };

// "Add a site" — the lightest possible path. No autoblog, no
// sitemap, no webhook. Just the domain (and an optional display
// name). Sites added here can be scanned immediately from the
// dashboard; autoblog setup is a separate, optional step at
// /autoblog/setup.

export default async function NewSitePage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  return (
    <div className="mx-auto max-w-xl space-y-6">
      <div>
        <Link
          href="/dashboard"
          className="text-sm text-[var(--color-muted)]"
        >
          ← Dashboard
        </Link>
        <h1 className="mt-4 text-3xl font-bold">Add a site</h1>
        <p className="mt-2 text-[var(--color-muted)]">
          Add a domain you want to scan or audit. This does <strong>not</strong>{" "}
          enrol the site in autoblog publishing or backlink exchange —
          those are opt-in steps you can take later from{" "}
          <Link href="/autoblog/setup" className="underline">
            /autoblog/setup
          </Link>
          .
        </p>
      </div>

      <section className="card p-5">
        <NewSiteForm />
      </section>
    </div>
  );
}
