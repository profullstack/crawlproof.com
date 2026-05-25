import { GuideForm } from "@/components/guide-form";

export const metadata = {
  title: "Get guide — CrawlProof Premium",
  description:
    "Download the CrawlProof premium guide: a practical PDF deck for improving AI search visibility with multi-engine AEO scans, reporting, and Autoblog.",
  alternates: { canonical: "/get-guide" },
  openGraph: {
    title: "Get guide · CrawlProof",
    description:
      "Download the CrawlProof premium guide for AI search visibility and AEO growth workflows.",
    url: "/get-guide",
  },
};

const inside = [
  "How multi-engine AEO scans expose visibility gaps that a single crawler misses",
  "The CrawlProof workflow for tracking fixes from audit finding to measurable lift",
  "Where Autoblog fits: scheduled posts, webhook delivery, and credit-based publishing",
  "How premium reporting helps agencies and growth teams prove before/after movement",
  "A practical rollout path for teams that want AI assistants to find and cite them",
];

export default function GetGuidePage() {
  return (
    <main>
      <section className="mx-auto grid max-w-6xl items-start gap-8 px-4 py-12 sm:px-6 sm:py-16 lg:grid-cols-[1fr_24rem]">
        <div>
          <p className="text-xs uppercase tracking-wider text-[var(--color-accent)]">
            Free guide
          </p>
          <h1 className="mt-2 text-balance text-4xl font-extrabold leading-tight sm:text-5xl">
            CrawlProof Premium Guide
          </h1>
          <p className="mt-4 max-w-3xl text-lg text-[var(--color-muted)]">
            A practical PDF deck for teams that want to turn AEO audits into
            ranked fixes, executive-ready reporting, and a repeatable content
            loop for AI search visibility.
          </p>

          <div className="mt-8 grid gap-4 md:grid-cols-[0.85fr_1.15fr]">
            <div className="rounded-xl border border-[var(--color-border)] bg-[#101820] p-5">
              <div className="rounded-lg border border-[rgba(110,231,183,0.35)] bg-[rgba(110,231,183,0.12)] p-4">
                <div className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
                  PDF deck
                </div>
                <div className="mt-3 text-5xl font-extrabold text-[var(--color-accent)]">
                  8
                </div>
                <div className="mt-1 text-sm text-[var(--color-muted)]">
                  pages for operators, founders, agencies, and growth teams
                </div>
              </div>
              <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
                <div className="rounded-lg bg-[#17202a] p-3">
                  <div className="text-xs text-[var(--color-muted)]">Format</div>
                  <div className="mt-1 font-semibold">PDF</div>
                </div>
                <div className="rounded-lg bg-[#17202a] p-3">
                  <div className="text-xs text-[var(--color-muted)]">Access</div>
                  <div className="mt-1 font-semibold">No paywall</div>
                </div>
              </div>
            </div>

            <div className="card p-5">
              <p className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
                What&apos;s inside
              </p>
              <ul className="mt-4 space-y-3 text-sm leading-relaxed">
                {inside.map((item) => (
                  <li key={item} className="flex gap-3">
                    <span className="mt-0.5 text-[var(--color-accent)]">✓</span>
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          <section className="mt-10">
            <h2 className="text-2xl font-bold">From audit to growth loop.</h2>
            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              <GuideStep n="01" title="Scan" body="Run rule-based and AI-engine audits against the pages buyers and bots actually see." />
              <GuideStep n="02" title="Fix" body="Prioritize schema, rendering, content clarity, llms.txt, and citation-ready answers." />
              <GuideStep n="03" title="Publish" body="Use Autoblog support to keep useful SEO posts moving through your own CMS." />
            </div>
          </section>
        </div>

        <div className="lg:sticky lg:top-28">
          <GuideForm />
        </div>
      </section>
    </main>
  );
}

function GuideStep({ n, title, body }: { n: string; title: string; body: string }) {
  return (
    <div className="card p-4">
      <div className="font-mono text-sm text-[var(--color-accent)]">{n}</div>
      <h3 className="mt-2 font-bold">{title}</h3>
      <p className="mt-1 text-sm text-[var(--color-muted)]">{body}</p>
    </div>
  );
}
