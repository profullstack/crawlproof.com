import Link from "next/link";
import { unsubscribeOrgAudienceByToken } from "@/lib/marketing";

export const metadata = { title: "Unsubscribe" };
export const dynamic = "force-dynamic";

export default async function OrgUnsubscribePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const result = await unsubscribeOrgAudienceByToken(token);

  return (
    <main className="mx-auto max-w-md px-4 py-12 sm:px-6 sm:py-16">
      <h1 className="text-3xl font-bold">
        {result.ok ? "You're unsubscribed" : "Unsubscribe link not recognized"}
      </h1>
      {result.ok ? (
        <p className="mt-3 text-[var(--color-muted)]">
          {result.email ? (
            <>
              <strong>{result.email}</strong> won&apos;t receive any more emails
              from us.
            </>
          ) : (
            <>You won&apos;t receive any more emails from us.</>
          )}
        </p>
      ) : (
        <p className="mt-3 text-[var(--color-muted)]">
          We couldn&apos;t find a subscription for that link. It may have
          already been unsubscribed, or the link may be malformed.
        </p>
      )}
      <Link href="/" className="mt-6 inline-block text-sm text-[var(--color-muted)]">
        ← Back to CrawlProof
      </Link>
    </main>
  );
}
