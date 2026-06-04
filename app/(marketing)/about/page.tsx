export const metadata = {
  title: "About",
  description:
    "CrawlProof is an SEO, AEO, and GEO auditor — built so site owners can see exactly what LLM crawlers and generative AI engines find on their pages, and what they miss.",
  alternates: { canonical: "/about" },
  openGraph: {
    title: "About CrawlProof",
    description:
      "SEO + AEO + GEO auditing for the AI-search era. See what LLM crawlers find on your site — and what they miss.",
    url: "/about",
  },
};

export default function AboutPage() {
  return (
    <main className="mx-auto max-w-3xl px-4 sm:px-6 py-16">
      <h1 className="text-4xl font-extrabold">About CrawlProof</h1>
      <div className="prose mt-6 max-w-none text-[var(--color-fg)]">
        <p className="text-lg text-[var(--color-muted)]">
          CrawlProof was built because the SEO toolchain is optimized for blue links, the AEO
          toolchain barely exists, and GEO barely has a name yet. We answer one question:{" "}
          <em>can an LLM actually understand, cite, and recommend your site?</em>
        </p>
        <h2 className="mt-10 text-2xl font-bold">Three pillars</h2>
        <dl className="mt-4 space-y-4 text-[var(--color-muted)]">
          <div>
            <dt className="font-semibold text-[var(--color-fg)]">SEO — Search Engine Optimization</dt>
            <dd className="mt-1">
              The foundation: fast pages, clean HTML, canonical URLs, sitemap coverage, broken-link
              checks. Blue-link search still drives the majority of discovery.
            </dd>
          </div>
          <div>
            <dt className="font-semibold text-[var(--color-fg)]">AEO — Answer Engine Optimization</dt>
            <dd className="mt-1">
              Making sure AI answer engines (ChatGPT, Claude, Perplexity, Google AI Overviews) can
              access, read, and render your content. Covers AI-bot rules, structured data, llms.txt
              access, and content snippet-readiness.
            </dd>
          </div>
          <div>
            <dt className="font-semibold text-[var(--color-fg)]">GEO — Generative Engine Optimization</dt>
            <dd className="mt-1">
              Making sure generative AI <em>cites</em> you, not just reads you. Covers llms.txt
              content quality, knowledge graph anchoring (sameAs links), AI agent integration files,
              brand entity clarity, and outbound citation signals.
            </dd>
          </div>
        </dl>
        <h2 className="mt-10 text-2xl font-bold">How it works</h2>
        <p className="mt-2 text-[var(--color-muted)]">
          We fetch your site twice — once as plain HTML, once as a fully-rendered browser.
          We compare what an AI crawler can read against what a user sees. We check robots.txt,
          sitemap.xml, llms.txt depth and quality, skill.md, structured data, knowledge graph
          sameAs links, AI agent integration files, and the rules your site exposes for
          GPTBot, ClaudeBot, PerplexityBot, and others. Then we score it.
        </p>
        <h2 className="mt-10 text-2xl font-bold">Privacy</h2>
        <p className="mt-2 text-[var(--color-muted)]">
          Audits run as <code>CrawlProofBot/1.0</code>. We never log in, submit forms, or POST.
          You can choose to discard raw HTML after a run — only structured findings will persist.
        </p>
      </div>
    </main>
  );
}
