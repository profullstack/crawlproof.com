import Link from "next/link";
import { confirmWatchByToken } from "@/app/actions/watchScan";

export const metadata = {
  title: "Confirm watch",
  robots: { index: false, follow: false },
};
export const dynamic = "force-dynamic";

export default async function ConfirmWatchPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const result = await confirmWatchByToken(token);

  return (
    <main className="mx-auto max-w-md px-4 py-12 sm:px-6 sm:py-16">
      <h1 className="text-3xl font-bold">
        {result.ok ? "You're watching it" : "Confirmation link not recognized"}
      </h1>
      {result.ok ? (
        <p className="mt-3 text-[var(--color-muted)]">
          We&apos;ll re-scan <strong>{result.host}</strong> {result.cadence} and
          email you when its score actually moves. Every message has a one-click
          stop link.
        </p>
      ) : (
        <p className="mt-3 text-[var(--color-muted)]">
          We couldn&apos;t find a watch for that link. It may have already been
          replaced by a newer confirmation email, or the link may be malformed.
        </p>
      )}
      <Link href="/" className="mt-6 inline-block text-sm text-[var(--color-muted)]">
        ← Back to CrawlProof
      </Link>
    </main>
  );
}
