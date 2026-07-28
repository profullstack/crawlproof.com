import { HireForm } from "@/components/hire-form";

export const metadata = {
  title: "Hire us — done-for-you AEO fixes",
  description:
    "Get a human team to fix your website's AEO (Answer Engine Optimization) so AI assistants and bots can find, cite, and recommend your site. Scoped from your scan and billed by the hour.",
  alternates: { canonical: "/hire" },
  openGraph: {
    title: "Hire us · CrawlProof",
    description:
      "Get your website's AEO fixed by a human team, scoped from a real scan of your site.",
    url: "/hire",
  },
};

export default async function HirePage({
  searchParams,
}: {
  searchParams: Promise<{ email?: string; website?: string }>;
}) {
  const sp = await searchParams;
  return (
    <main className="mx-auto max-w-3xl px-4 sm:px-6 py-16">
      <p className="text-xs uppercase tracking-wider text-[var(--color-accent)]">
        Done-for-you
      </p>
      <h1 className="mt-2 text-4xl font-extrabold leading-tight sm:text-5xl">
        We&apos;ll fix your site&apos;s AEO — properly.
      </h1>
      <p className="mt-4 max-w-2xl text-lg text-[var(--color-muted)]">
        Schema, llms.txt, AI-bot-friendly rendering, internal linking,
        citation-ready answers — applied directly to your site so ChatGPT,
        Claude, Perplexity, and Google AI overviews can actually find and
        recommend you.
      </p>

      <ul className="mt-6 grid gap-3 text-sm sm:grid-cols-2">
        <li className="card p-4">
          <strong>Scoped from your scan</strong>
          <p className="mt-1 text-[var(--color-muted)]">
            We price the work off what the report actually found, at $100/hour.
            Most engagements run two to three weeks.
          </p>
        </li>
        <li className="card p-4">
          <strong>Human + AI team</strong>
          <p className="mt-1 text-[var(--color-muted)]">
            Audits run on our engines; fixes are reviewed and shipped by people.
          </p>
        </li>
        <li className="card p-4">
          <strong>Before/after report</strong>
          <p className="mt-1 text-[var(--color-muted)]">
            You get a CrawlProof scan before and after so the lift is provable.
          </p>
        </li>
        <li className="card p-4">
          <strong>Any stack</strong>
          <p className="mt-1 text-[var(--color-muted)]">
            Shopify, WordPress, Next.js, Webflow, custom — we work with what
            you have.
          </p>
        </li>
      </ul>

      <div className="mt-10">
        <h2 className="text-xl font-semibold">Tell us about your site</h2>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          A few quick details and we&apos;ll reply with next steps.
        </p>
        <div className="mt-4">
          <HireForm defaultEmail={sp.email ?? ""} defaultWebsite={sp.website ?? ""} />
        </div>
      </div>
    </main>
  );
}
