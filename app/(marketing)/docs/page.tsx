import Link from "next/link";

export const metadata = {
  title: "Docs",
  description:
    "CrawlProof developer documentation: AEO Score, drop-in stats tracker, autoblog webhook integration.",
  alternates: { canonical: "/docs" },
};

interface DocCard {
  href: string;
  title: string;
  description: string;
}

const DOCS: DocCard[] = [
  {
    href: "/docs/aeo-score",
    title: "AEO Score",
    description:
      "How CrawlProof rolls per-engine audit scores into a single 0–100 number you can track over time, and what to do to make it climb.",
  },
  {
    href: "/docs/stats-tracker",
    title: "Stats tracker",
    description:
      "Drop a one-line <script> tag on your site and see which AI engines refer you, which AI crawlers visit, and how that mix changes day to day.",
  },
  {
    href: "/docs/autoblog-webhook",
    title: "Autoblog webhook",
    description:
      "Receive scheduled SEO posts at your own endpoint. CloudEvents 1.0 envelope, Standard Webhooks signing, copy-paste verifier via @profullstack/autoblog.",
  },
];

export default function DocsIndexPage() {
  return (
    <main className="mx-auto max-w-3xl px-4 py-16 sm:px-6">
      <h1 className="text-4xl font-extrabold">Docs</h1>
      <p className="mt-3 text-[var(--color-muted)]">
        Developer-facing guides for the parts of CrawlProof you integrate
        with — the score that ranks your AEO health, the tracker that
        watches your live AI traffic, and the webhook that delivers
        autoblog posts to your CMS.
      </p>

      <div className="mt-10 grid gap-4">
        {DOCS.map((d) => (
          <Link
            key={d.href}
            href={d.href}
            className="block rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-5 transition hover:border-[var(--color-foreground)]"
          >
            <h2 className="text-xl font-bold">{d.title}</h2>
            <p className="mt-1 text-sm text-[var(--color-muted)]">
              {d.description}
            </p>
            <p className="mt-3 text-sm font-medium">Read →</p>
          </Link>
        ))}
      </div>

      <p className="mt-10 text-sm text-[var(--color-muted)]">
        Need something else? Email{" "}
        <a className="underline" href="mailto:hello@crawlproof.com">
          hello@crawlproof.com
        </a>
        .
      </p>
    </main>
  );
}
