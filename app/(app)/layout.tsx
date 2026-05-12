import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("display_name, email, credits_balance")
    .eq("id", user.id)
    .maybeSingle();

  return (
    <div>
      <header className="border-b border-[var(--color-border)]">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3">
          <Link href="/dashboard" className="flex items-center gap-2 font-bold">
            <span className="inline-block size-2 rounded-full bg-[var(--color-accent)]" />
            CrawlProof
          </Link>
          <nav className="flex items-center gap-6 text-sm text-[var(--color-muted)]">
            <Link href="/dashboard">Dashboard</Link>
            <Link href="/projects/new">New project</Link>
            <Link href="/settings">Settings</Link>
            <Link
              href="/settings/billing"
              className="badge badge-pass font-mono"
              title="Scan credits — click to buy more"
            >
              {profile?.credits_balance ?? 0} credits
            </Link>
            <form action="/auth/signout" method="POST">
              <button type="submit" className="text-sm hover:text-[var(--color-fg)]">
                Sign out
              </button>
            </form>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-6 py-10">{children}</main>
    </div>
  );
}
