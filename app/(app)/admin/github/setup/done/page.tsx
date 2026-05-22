// Admin-only: receives the App Manifest conversion result from
// /api/github/setup-callback. Secrets land in the URL fragment (not the
// query) so they aren't sent to the server / logged. A tiny client
// component reads them and formats them for the admin to paste into
// Railway.

import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { SetupDoneClient } from "./client";

export const metadata = {
  title: "Admin · GitHub App created",
  robots: { index: false, follow: false },
};

export default async function AdminGithubSetupDonePage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) notFound();
  const { data: me } = await supabase
    .from("profiles")
    .select("is_admin")
    .eq("id", user.id)
    .maybeSingle();
  if (!me?.is_admin) notFound();

  return (
    <main className="mx-auto max-w-3xl px-4 py-12 sm:px-6">
      <p className="text-sm">
        <Link href="/admin" className="text-[var(--color-muted)] hover:underline">
          ← Admin
        </Link>
      </p>
      <h1 className="mt-2 text-3xl font-extrabold">App created ✓</h1>
      <p className="mt-3 text-[var(--color-muted)]">
        Copy each value into Railway, set them on both the Next.js app
        and the worker service, then redeploy. After deploy, end users
        can install the App from their own{" "}
        <Link className="underline" href="/settings/integrations/github">
          GitHub settings page
        </Link>
        .
      </p>
      <SetupDoneClient />
    </main>
  );
}
