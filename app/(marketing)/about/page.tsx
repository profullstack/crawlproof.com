export const metadata = { title: "About" };

export default function AboutPage() {
  return (
    <main className="mx-auto max-w-3xl px-4 sm:px-6 py-16">
      <h1 className="text-4xl font-extrabold">About CrawlProof</h1>
      <div className="prose mt-6 max-w-none text-[var(--color-fg)]">
        <p className="text-lg text-[var(--color-muted)]">
          CrawlProof was built because the SEO toolchain is optimized for blue links, and the
          AEO toolchain barely exists. We answer one question: <em>can an LLM actually
          understand and cite your site?</em>
        </p>
        <h2 className="mt-10 text-2xl font-bold">How it works</h2>
        <p className="mt-2 text-[var(--color-muted)]">
          We fetch your site twice — once as plain HTML, once as a fully-rendered browser.
          We compare what an AI crawler can read against what a user sees. We check robots.txt,
          sitemap.xml, llms.txt, skill.md, structured data, and the rules your site exposes for
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
