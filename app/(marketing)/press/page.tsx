export const metadata = {
  title: "Press & News",
  description:
    "Press resources, media coverage, and news about CrawlProof — the AEO, SEO, and GEO auditor for the AI-search era.",
  alternates: { canonical: "/press" },
  openGraph: {
    title: "Press & News · CrawlProof",
    description:
      "Press resources, media coverage, and news about CrawlProof — the AEO, SEO, and GEO auditor for the AI-search era.",
    url: "/press",
  },
};

const COVERAGE: { outlet: string; title: string; url: string; date: string }[] = [
  // Add coverage items here as they are published, e.g.:
  // {
  //   outlet: "TechCrunch",
  //   title: "CrawlProof launches AEO auditing for the AI-search era",
  //   url: "https://techcrunch.com/...",
  //   date: "2025-01-01",
  // },
];

export default function PressPage() {
  return (
    <main className="mx-auto max-w-3xl px-4 sm:px-6 py-16">
      <h1 className="text-4xl font-extrabold">Press &amp; News</h1>
      <p className="mt-4 text-lg text-[var(--color-muted)]">
        Resources for journalists, analysts, and anyone writing about CrawlProof,
        AEO, or AI-search optimization.
      </p>

      {/* Press contact */}
      <section className="mt-12">
        <h2 className="text-2xl font-bold">Press contact</h2>
        <p className="mt-3 text-[var(--color-muted)]">
          For interviews, data requests, or media inquiries, reach us at{" "}
          <a
            href="mailto:press@crawlproof.com"
            className="underline text-[var(--color-fg)]"
          >
            press@crawlproof.com
          </a>
          . We aim to respond within one business day.
        </p>
      </section>

      {/* Brand assets */}
      <section className="mt-12">
        <h2 className="text-2xl font-bold">Brand assets</h2>
        <p className="mt-3 text-[var(--color-muted)]">
          Our logo and brand mark are available as an SVG at{" "}
          <code className="rounded bg-[var(--color-card)] px-1 py-0.5 text-sm">
            /logo.svg
          </code>
          . Please do not modify the logo proportions or colours without
          permission.
        </p>
        <ul className="mt-4 space-y-2 text-sm text-[var(--color-muted)]">
          <li>
            <span className="font-semibold text-[var(--color-fg)]">Full name:</span>{" "}
            CrawlProof
          </li>
          <li>
            <span className="font-semibold text-[var(--color-fg)]">Short form:</span>{" "}
            CrawlProof (no space, capital C and P)
          </li>
          <li>
            <span className="font-semibold text-[var(--color-fg)]">Product category:</span>{" "}
            AEO / SEO / GEO auditing platform
          </li>
          <li>
            <span className="font-semibold text-[var(--color-fg)]">Founded:</span> 2024
          </li>
        </ul>
      </section>

      {/* Boilerplate */}
      <section className="mt-12">
        <h2 className="text-2xl font-bold">About CrawlProof (boilerplate)</h2>
        <p className="mt-3 text-[var(--color-muted)]">
          CrawlProof is an AEO, SEO, and GEO auditing platform that shows site owners
          exactly what LLM crawlers and generative AI engines find on their pages — and
          what they miss. By fetching pages both as raw HTML and as a fully-rendered
          browser, CrawlProof exposes gaps in structured data, robots rules,
          llms.txt quality, knowledge-graph anchoring, and AI-agent integration files.
          The result is a clear, actionable score for AI-search visibility.
        </p>
      </section>

      {/* Media coverage */}
      <section className="mt-12">
        <h2 className="text-2xl font-bold">Media coverage</h2>
        {COVERAGE.length === 0 ? (
          <p className="mt-3 text-[var(--color-muted)]">
            No press coverage has been added yet. If you have written about
            CrawlProof and would like to be listed here, email{" "}
            <a
              href="mailto:press@crawlproof.com"
              className="underline text-[var(--color-fg)]"
            >
              press@crawlproof.com
            </a>
            .
          </p>
        ) : (
          <ul className="mt-4 space-y-4">
            {COVERAGE.map((item) => (
              <li key={item.url} className="card p-4">
                <a
                  href={item.url}
                  target="_blank"
                  rel="noreferrer"
                  className="font-semibold underline text-[var(--color-fg)]"
                >
                  {item.title}
                </a>
                <p className="mt-1 text-xs text-[var(--color-muted)]">
                  {item.outlet} &mdash; {item.date}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
