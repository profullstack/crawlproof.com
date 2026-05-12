export const metadata = { title: "About CrawlProofBot" };

export default function BotPage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <h1 className="text-4xl font-extrabold">CrawlProofBot</h1>
      <p className="mt-4 text-[var(--color-muted)]">
        CrawlProofBot is the user agent CrawlProof uses to fetch pages when a customer asks us
        to audit a site. We crawl politely, identify ourselves clearly, and honor robots.txt.
      </p>

      <h2 className="mt-10 text-2xl font-bold">User agent</h2>
      <pre className="card mt-3 overflow-x-auto p-4 text-sm font-mono">
{`CrawlProofBot/1.0 (+https://crawlproof.com/bot)`}
      </pre>

      <h2 className="mt-10 text-2xl font-bold">Behavior</h2>
      <ul className="mt-3 list-disc space-y-1 pl-6 text-[var(--color-muted)]">
        <li>Only crawls when a customer requests an audit for that URL.</li>
        <li>Reads robots.txt and respects directives that target our user agent.</li>
        <li>Never logs in, never submits forms, never POSTs.</li>
        <li>Fetches at most ~15 pages per audit run.</li>
        <li>Identifies itself in every request with the User-Agent above.</li>
      </ul>

      <h2 className="mt-10 text-2xl font-bold">Block us</h2>
      <p className="mt-3 text-[var(--color-muted)]">
        To prevent CrawlProofBot from accessing your site, add the following to your robots.txt:
      </p>
      <pre className="card mt-3 overflow-x-auto p-4 text-sm font-mono">
{`User-agent: CrawlProofBot
Disallow: /`}
      </pre>
    </main>
  );
}
