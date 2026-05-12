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
      <header className="sticky top-0 z-20 border-b border-[var(--color-border)] bg-[var(--color-bg)]/85 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <Link
            href="/dashboard"
            className="flex shrink-0 items-center gap-2 font-bold"
          >
            <span className="inline-block size-2 rounded-full bg-[var(--color-accent)]" />
            CrawlProof
          </Link>
          <nav className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-[var(--color-muted)]">
            <Link href="/dashboard">Dashboard</Link>
            <Link href="/projects/new" className="hidden sm:inline">
              New
            </Link>
            <Link href="/settings" className="hidden sm:inline">
              Settings
            </Link>
            <Link
              href="/settings/billing"
              className="badge badge-pass font-mono"
              title="Scan credits — click to buy more"
            >
              {profile?.credits_balance ?? 0} cr
            </Link>
            <form action="/auth/signout" method="POST">
              <button type="submit" className="hover:text-[var(--color-fg)]">
                Sign out
              </button>
            </form>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-10">{children}</main>
    </div>
  );
}
