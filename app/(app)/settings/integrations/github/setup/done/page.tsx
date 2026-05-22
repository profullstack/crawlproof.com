// "App created" page. Secrets land in the URL fragment (not the query)
// so they aren't sent to the server / logged. A tiny client component
// reads them and renders the values for the admin to copy into Railway.

import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { SetupDoneClient } from "./client";

export default async function GithubAppSetupDonePage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?redirect=/settings/integrations/github/setup/done");

  const { data: profile } = await supabase
    .from("profiles")
    .select("is_admin")
    .eq("id", user.id)
    .maybeSingle();
  if (!profile?.is_admin) {
    redirect("/settings/integrations/github?error=setup_admin_only");
  }

  return (
    <main className="mx-auto max-w-3xl px-4 py-12 sm:px-6">
      <p className="text-sm">
        <Link
          href="/settings/integrations/github"
          className="text-[var(--color-muted)] hover:underline"
        >
          ← GitHub settings
        </Link>
      </p>
      <h1 className="mt-2 text-3xl font-extrabold">App created ✓</h1>
      <p className="mt-3 text-[var(--color-muted)]">
        Copy each value into Railway, set them on both the Next.js app and
        the worker service, then redeploy. After deploy, head back to{" "}
        <Link
          className="underline"
          href="/settings/integrations/github"
        >
          GitHub settings
        </Link>{" "}
        and click <strong>Install</strong> to grant repo access.
      </p>
      <SetupDoneClient />
    </main>
  );
}
