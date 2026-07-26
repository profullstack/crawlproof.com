import Link from "next/link";
import { unsubscribeByToken } from "@/lib/marketing";
import { suppressByToken } from "@/lib/outreach/suppress";

export const metadata = { title: "Unsubscribe" };
export const dynamic = "force-dynamic";

export default async function UnsubscribePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ scope?: string }>;
}) {
  const { token } = await params;
  const { scope } = await searchParams;

  // One token space, two sources: the opt-in newsletter list and cold
  // outreach. Try the newsletter first (far more tokens live there), then the
  // outreach prospects.
  const marketing = await unsubscribeByToken(token);
  const outreach = marketing.ok
    ? null
    : await suppressByToken(token, scope === "domain" ? "domain" : "email");
  const ok = marketing.ok || !!outreach?.ok;

  return (
    <main className="mx-auto max-w-md px-4 py-12 sm:px-6 sm:py-16">
      <h1 className="text-3xl font-bold">
        {ok ? "You're unsubscribed" : "Unsubscribe link not recognized"}
      </h1>
      {ok ? (
        <p className="mt-3 text-[var(--color-muted)]">
          {marketing.ok ? (
            marketing.email ? (
              <>
                <strong>{marketing.email}</strong> won&apos;t receive CrawlProof
                marketing emails anymore. Transactional emails (audit reports,
                receipts) are unaffected.
              </>
            ) : (
              <>You won&apos;t receive any more marketing emails from us.</>
            )
          ) : outreach?.scope === "domain" ? (
            <>
              Nobody at <strong>{outreach.value}</strong> will be contacted by
              CrawlProof again — every address at the domain, not just the one
              we wrote to.
            </>
          ) : (
            <>
              <strong>{outreach?.value}</strong> is on our do-not-contact list.
              We won&apos;t write again.
            </>
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
