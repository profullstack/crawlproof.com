import Link from "next/link";
import { createClient } from "@/lib/supabase/server";

export async function SiteHeader() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return (
    <header className="sticky top-0 z-20 border-b border-[var(--color-border)] bg-[var(--color-bg)]/85 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
        <Link href="/" className="flex shrink-0 items-center" aria-label="CrawlProof home">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo.svg" alt="CrawlProof" className="h-16 w-auto" />
        </Link>
        <nav className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-[var(--color-muted)]">
          <Link
            href="/hire"
            className="font-semibold text-[var(--color-accent)]"
          >
            Hire us
          </Link>
          <Link href="/pricing">Pricing</Link>
          <Link href="/ads">Ads</Link>
          <Link href="/get-guide">Guide</Link>
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
