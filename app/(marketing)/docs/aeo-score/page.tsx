import Link from "next/link";

export const metadata = {
  title: "AEO Score",
  description:
    "How CrawlProof rolls per-engine audit scores into a single 0–100 AEO Score, what the trend chart represents, and what improves it.",
  alternates: { canonical: "/docs/aeo-score" },
};

export default function AeoScoreDocsPage() {
  return (
    <main className="mx-auto max-w-3xl px-4 py-16 sm:px-6">
      <p className="text-sm">
        <Link href="/docs" className="text-[var(--color-muted)] hover:underline">
          ← Docs
        </Link>
      </p>
      <h1 className="mt-2 text-4xl font-extrabold">AEO Score</h1>
      <p className="mt-3 text-[var(--color-muted)]">
        Your <strong>AEO Score</strong> is a single 0–100 number per project
        that summarizes how well AI answer engines can actually find,
        understand, and cite your site. It rolls up the per-engine audit
        scores from your scheduled scans into one trend you can track over
        time — and it&apos;s the number to watch as you ship fixes.
      </p>

      <section className="mt-10 space-y-3">
        <h2 className="text-2xl font-bold">How it&apos;s computed</h2>
        <p className="text-sm leading-relaxed">
          Each scan run produces one audit per engine you have enabled
          (Claude, OpenAI, Gemini, Perplexity, Qwen, Kimi, DeepSeek, plus
          the local rule engine). Every audit gets its own 0–100 score
          based on what each engine could find and understand. Once the
          whole scan run is done, we average the scores of all{" "}
          <em>completed</em> engines and store one{" "}
          <code className="font-mono">project_scores</code> row with:
        </p>
        <ul className="list-disc pl-5 text-sm leading-relaxed">
          <li>
            <code className="font-mono">score</code> — the rolled-up
            number (mean of completed engine scores, rounded to an int).
          </li>
          <li>
            <code className="font-mono">components</code> — the per-engine
            breakdown, e.g.{" "}
            <code className="font-mono">
              {`{ claude: 78, openai: 82, gemini: 70 }`}
            </code>
            . Used by the chips on the project overview.
          </li>
          <li>
            <code className="font-mono">recorded_at</code> — the moment
            the run completed.
          </li>
        </ul>
        <p className="text-sm leading-relaxed">
          Failed engines (LLM timeout, network blip) are excluded from the
          mean — a run where every engine fails records no row at all, to
          avoid misleading zeros on the trend chart.
        </p>
      </section>

      <section className="mt-10 space-y-3">
        <h2 className="text-2xl font-bold">The trend chart</h2>
        <p className="text-sm leading-relaxed">
          On the project Overview tab, the AEO Score card shows your
          latest number, the delta across the visible window, a small
          sparkline of recent runs, and chips for each engine&apos;s last
          score. Tap into the score on any individual run for the full
          per-engine breakdown.
        </p>
        <p className="text-sm leading-relaxed">
          A single point appears after your first scan run completes. The
          sparkline becomes meaningful after a couple of runs — schedule
          weekly scans (
          <Link className="underline" href="/dashboard">
            dashboard
          </Link>{" "}
          → project → Schedule) so you build a useful history.
        </p>
      </section>

      <section className="mt-10 space-y-3">
        <h2 className="text-2xl font-bold">Score bands</h2>
        <ul className="list-disc pl-5 text-sm leading-relaxed">
          <li>
            <strong>80–100</strong> — green. AI engines can find,
            understand, and confidently cite your site.
          </li>
          <li>
            <strong>50–79</strong> — yellow. Real gaps but the basics
            work; usually missing structured data, llms.txt, or
            positioning clarity.
          </li>
          <li>
            <strong>0–49</strong> — red. Major issues — robots, rendered
            content, or AI-bot access blocking discovery. The full audit
            report calls these out.
          </li>
        </ul>
      </section>

      <section className="mt-10 space-y-3">
        <h2 className="text-2xl font-bold">What moves the number</h2>
        <ul className="list-disc pl-5 text-sm leading-relaxed">
          <li>
            <strong>llms.txt</strong> — a one-page summary AI crawlers can
            pull instead of guessing. Each engine gives extra credit when
            it&apos;s present and well-formed.
          </li>
          <li>
            <strong>JSON-LD structured data</strong> — Organization,
            SoftwareApplication, FAQPage, BreadcrumbList. Concrete signals
            engines can quote verbatim.
          </li>
          <li>
            <strong>Rendered-vs-static text ratio</strong> — content that
            only exists post-JS is invisible to most AI crawlers. The
            ratio shows up as a check.
          </li>
          <li>
            <strong>AI-bot rules in robots.txt</strong> — explicitly
            allowing GPTBot, ClaudeBot, PerplexityBot, Google-Extended,
            etc. unblocks the engines that look for permission.
          </li>
          <li>
            <strong>Positioning clarity</strong> — who, what, who-for,
            pricing, CTA, all answerable from the homepage in a few
            sentences. Engines that read the page can&apos;t cite what
            isn&apos;t there.
          </li>
        </ul>
        <p className="text-sm leading-relaxed">
          Every audit run includes specific recommendations under each
          failing check — start there.
        </p>
      </section>

      <p className="mt-10 text-sm text-[var(--color-muted)]">
        Questions?{" "}
        <a className="underline" href="mailto:hello@crawlproof.com">
          hello@crawlproof.com
        </a>
        .
      </p>
    </main>
  );
}
