import Link from "next/link";
import { createClient } from "@/lib/supabase/server";

export async function SiteHeader() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return (
    <header className="sticky top-0 z-20 border-b border-[var(--color-border)] bg-[var(--color-bg)]/85 backdrop-blur">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
        <Link
          href="/"
          className="flex shrink-0 items-center gap-2 font-bold"
        >
          <span className="inline-block size-2 rounded-full bg-[var(--color-accent)]" />
          CrawlProof
        </Link>
        <nav className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-[var(--color-muted)]">
          <Link href="/pricing">Pricing</Link>
          <Link href="/recent">Recent</Link>
          <Link href="/about" className="hidden sm:inline">
            About
          </Link>
          <Link href="/blog" className="hidden sm:inline">
            Blog
          </Link>
          {user ? (
            <Link href="/dashboard" className="btn btn-primary px-3 py-1.5 text-sm">
              Dashboard
            </Link>
          ) : (
            <>
              <Link href="/login">Sign in</Link>
              <Link href="/signup" className="btn btn-primary px-3 py-1.5 text-sm">
                Get started
              </Link>
            </>
          )}
        </nav>
      </div>
    </header>
  );
}
