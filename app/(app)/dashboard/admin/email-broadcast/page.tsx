import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { serviceClient } from "@/lib/supabase/service";
import { EmailBroadcastForm } from "./EmailBroadcastForm";

export const metadata = {
  title: "Email broadcast · Admin · Crawlproof",
  robots: { index: false, follow: false },
};

export default async function EmailBroadcastPage() {
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
  if (!me?.is_admin) notFound();

  return (
    <div className="mx-auto max-w-2xl space-y-8">
      <div>
        <Link
          href="/dashboard/admin"
          className="text-sm text-[var(--color-muted)] hover:opacity-80"
        >
          ← Admin
        </Link>
        <h1 className="mt-3 text-3xl font-bold">Email broadcast</h1>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          Send a mass email to all registered users.
        </p>
      </div>

      <section className="card p-5">
        <EmailBroadcastForm />
      </section>
    </div>
  );
}
