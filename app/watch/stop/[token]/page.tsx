import Link from "next/link";
import { stopWatchByToken } from "@/app/actions/watchScan";

export const metadata = {
  title: "Stop watching",
  robots: { index: false, follow: false },
};
export const dynamic = "force-dynamic";

// The human-facing landing page. Mail clients issuing an RFC 8058 one-click
// unsubscribe send a POST, which a page route cannot answer — that lands on
// /api/watch/stop/[token], which redirects GETs here.
export default async function StopWatchPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const result = await stopWatchByToken(token);

  return (
    <main className="mx-auto max-w-md px-4 py-12 sm:px-6 sm:py-16">
      <h1 className="text-3xl font-bold">
        {result.ok ? "Stopped" : "Link not recognized"}
      </h1>
      {result.ok ? (
        <p className="mt-3 text-[var(--color-muted)]">
          We&apos;ve stopped watching <strong>{result.host}</strong>. You
          won&apos;t get any more score-change emails for it. Other CrawlProof
          email (reports you request, receipts) is unaffected.
        </p>
      ) : (
        <p className="mt-3 text-[var(--color-muted)]">
          We couldn&apos;t find a watch for that link. It may already have been
          stopped.
        </p>
      )}
      <Link href="/" className="mt-6 inline-block text-sm text-[var(--color-muted)]">
        ← Back to CrawlProof
      </Link>
    </main>
  );
}
