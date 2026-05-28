import Link from "next/link";

export const metadata = {
  title: "Statistics",
  description:
    "Install CrawlProof's cookieless statistics tracker and track pageviews, sources, clicks, forms, scrolls, routes, and custom events.",
  alternates: { canonical: "/docs/statistics" },
};

export default function StatisticsDocsPage() {
  return (
    <main className="mx-auto max-w-3xl px-4 py-16 sm:px-6">
      <p className="text-sm">
        <Link href="/docs" className="text-[var(--color-muted)] hover:underline">
          ← Docs
        </Link>
      </p>
      <h1 className="mt-2 text-4xl font-extrabold">Statistics</h1>
      <p className="mt-3 text-[var(--color-muted)]">
        CrawlProof statistics is a cookieless tracker for pageviews,
        AI referrals, AI crawler visits, routes, clicks, forms, scrolls,
        downloads, outbound links, and custom events. It works with plain
        HTML, React, Next.js, Vue, Nuxt, Svelte, SvelteKit, Astro, Remix,
        Shopify themes, Webflow embeds, and anything else that can load a
        browser script.
      </p>

      <section className="mt-10 space-y-3">
        <h2 className="text-2xl font-bold">Install</h2>
        <p className="text-sm leading-relaxed">
          Enable the tracker from your project Stats tab, then install the
          script on every page you want tracked. The project id in{" "}
          <code className="font-mono">data-site</code> is the only required
          identifier.
        </p>
        <pre className="overflow-x-auto rounded border border-[var(--color-border)] bg-[#0b0d10] p-3 font-mono text-xs leading-relaxed">{`<script
  data-site="<your-project-id>"
  src="https://crawlproof.com/stats.js"
  async
></script>`}</pre>
        <p className="text-sm leading-relaxed">
          Put the tag in your app shell, layout, root template, or site-wide
          footer. Do not add API keys, auth tokens, cookies, or user ids.
        </p>
        <p className="text-sm leading-relaxed">
          If your site uses a strict Content Security Policy, allow{" "}
          <code className="font-mono">https://crawlproof.com</code> in{" "}
          <code className="font-mono">script-src</code> and{" "}
          <code className="font-mono">connect-src</code>. The GitHub
          auto-installer patches common CSP files such as{" "}
          <code className="font-mono">next.config.*</code>,{" "}
          <code className="font-mono">vercel.json</code>,{" "}
          <code className="font-mono">netlify.toml</code>, and{" "}
          <code className="font-mono">_headers</code> when it opens the PR.
        </p>
      </section>

      <section className="mt-10 space-y-3">
        <h2 className="text-2xl font-bold">Framework installs</h2>
        <pre className="overflow-x-auto rounded border border-[var(--color-border)] bg-[#0b0d10] p-3 font-mono text-xs leading-relaxed">{`// Next.js / React
import Script from "next/script";

export default function Layout({ children }) {
  return (
    <>
      {children}
      <Script
        data-site="<your-project-id>"
        src="https://crawlproof.com/stats.js"
        strategy="afterInteractive"
      />
    </>
  );
}`}</pre>
        <pre className="overflow-x-auto rounded border border-[var(--color-border)] bg-[#0b0d10] p-3 font-mono text-xs leading-relaxed">{`<!-- Vue, Nuxt, Svelte, SvelteKit, Astro, Webflow, plain HTML -->
<script
  data-site="<your-project-id>"
  src="https://crawlproof.com/stats.js"
  async
></script>`}</pre>
      </section>

      <section className="mt-10 space-y-3">
        <h2 className="text-2xl font-bold">Automatic tracking</h2>
        <p className="text-sm leading-relaxed">
          The tracker is plain browser JavaScript. It automatically sends
          anonymous HTTP requests for:
        </p>
        <ul className="list-disc pl-5 text-sm leading-relaxed">
          <li>Initial pageviews.</li>
          <li>
            SPA route changes via{" "}
            <code className="font-mono">history.pushState</code>,{" "}
            <code className="font-mono">history.replaceState</code>, and{" "}
            <code className="font-mono">popstate</code>.
          </li>
          <li>Internal clicks, outbound clicks, and download clicks.</li>
          <li>Button clicks and elements marked with tracking attributes.</li>
          <li>Form submits.</li>
          <li>Scroll milestones at 25%, 50%, 75%, and 100%.</li>
        </ul>
        <p className="text-sm leading-relaxed">
          Each request includes the project id, event name, current URL,
          current page&apos;s <code className="font-mono">document.referrer</code>,
          viewport, language, timezone, anonymous tab-scoped visitor/session
          ids, and a small target label when available. The server reads{" "}
          <code className="font-mono">User-Agent</code> and{" "}
          <code className="font-mono">Referer</code> from the HTTP request.
        </p>
      </section>

      <section className="mt-10 space-y-3">
        <h2 className="text-2xl font-bold">Custom events</h2>
        <p className="text-sm leading-relaxed">
          Use the global API after the script loads. This works from React,
          Vue, Svelte, or any browser code.
        </p>
        <pre className="overflow-x-auto rounded border border-[var(--color-border)] bg-[#0b0d10] p-3 font-mono text-xs leading-relaxed">{`window.crawlproof?.track("signup");
window.crawlproof?.track("checkout_started", "pricing_button");
window.crawlproof?.track("purchase", "pro_plan");`}</pre>
        <p className="text-sm leading-relaxed">
          You can also mark elements declaratively:
        </p>
        <pre className="overflow-x-auto rounded border border-[var(--color-border)] bg-[#0b0d10] p-3 font-mono text-xs leading-relaxed">{`<button data-cp-track="signup_clicked" data-cp-label="hero_cta">
  Start free
</button>

<a data-cp-track="docs_opened" href="/docs">
  Read docs
</a>`}</pre>
      </section>

      <section id="server-side" className="mt-10 space-y-3">
        <h2 className="text-2xl font-bold">Server-side, CLI, and programmatic</h2>
        <p className="text-sm leading-relaxed">
          The browser script just POSTs JSON to{" "}
          <code className="font-mono">/api/track</code>. Any backend, cron
          job, mobile app, or shell can hit the same endpoint — no SDK,
          no auth headers. The project id is the only required field.
        </p>
        <p className="text-sm leading-relaxed">curl:</p>
        <pre className="overflow-x-auto rounded border border-[var(--color-border)] bg-[#0b0d10] p-3 font-mono text-xs leading-relaxed">{`curl -X POST https://crawlproof.com/api/track \\
  -H "content-type: application/json" \\
  -d '{
    "site": "<your-project-uuid>",
    "event": "signup",
    "url": "https://example.com/pricing",
    "target": "hero_cta"
  }'`}</pre>
        <p className="text-sm leading-relaxed">Node / Deno / Bun:</p>
        <pre className="overflow-x-auto rounded border border-[var(--color-border)] bg-[#0b0d10] p-3 font-mono text-xs leading-relaxed">{`await fetch("https://crawlproof.com/api/track", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    site: process.env.CRAWLPROOF_PROJECT,
    event: "checkout_started",
    url: "https://example.com/pricing",
    target: "pro_plan",
  }),
});`}</pre>
        <p className="text-sm leading-relaxed">CLI (ships in the repo as <code className="font-mono">cli/index.ts</code>):</p>
        <pre className="overflow-x-auto rounded border border-[var(--color-border)] bg-[#0b0d10] p-3 font-mono text-xs leading-relaxed">{`crawlproof track \\
  --project=<your-project-uuid> \\
  --event=deploy \\
  --target=production`}</pre>
        <p className="text-sm leading-relaxed">
          Accepted fields: <code className="font-mono">site</code> (UUID, required),{" "}
          <code className="font-mono">event</code> (defaults to{" "}
          <code className="font-mono">pageview</code>),{" "}
          <code className="font-mono">url</code> or{" "}
          <code className="font-mono">path</code> (the page being tracked),{" "}
          <code className="font-mono">referrer</code>,{" "}
          <code className="font-mono">target</code> (short label). The
          server categorizes by{" "}
          <code className="font-mono">User-Agent</code> and{" "}
          <code className="font-mono">Referer</code> — set them from the
          HTTP client when you want bucket attribution other than &quot;direct&quot;.
          The response is always <code className="font-mono">204 No Content</code>.
        </p>
      </section>

      <section className="mt-10 space-y-3">
        <h2 className="text-2xl font-bold">Privacy model</h2>
        <ul className="list-disc pl-5 text-sm leading-relaxed">
          <li>No cookies.</li>
          <li>No localStorage.</li>
          <li>
            Session ids use <code className="font-mono">sessionStorage</code>{" "}
            when available and reset when the tab session ends.
          </li>
          <li>No fingerprinting.</li>
          <li>No auth tokens or API keys in the browser.</li>
          <li>No user ids required.</li>
          <li>No raw visitor sessions stored for the default tracker.</li>
        </ul>
        <p className="text-sm leading-relaxed">
          CrawlProof stores daily aggregate rollups by source, event, page,
          referrer host, target label, and location. The network request is
          best-effort and never blocks the host page.
        </p>
      </section>

      <section className="mt-10 space-y-3">
        <h2 className="text-2xl font-bold">Location data</h2>
        <p className="text-sm leading-relaxed">
          Location charts use the free MaxMind GeoLite2 City database on the
          server. The browser never sends an IP address, and CrawlProof does
          not store raw IPs. The API reads the request IP from trusted proxy
          headers, looks it up locally, and stores only daily aggregate fields:
          country, region, city, and timezone.
        </p>
        <pre className="overflow-x-auto rounded border border-[var(--color-border)] bg-[#0b0d10] p-3 font-mono text-xs leading-relaxed">{`MAXMIND_LICENSE_KEY=<your-maxmind-license-key>
MAXMIND_GEOLITE2_CITY_DB_PATH=data/GeoLite2-City.mmdb
npm run download-geolite2`}</pre>
        <p className="text-sm leading-relaxed">
          The <code className="font-mono">.mmdb</code> file is local-only and
          ignored by git. If the file is missing, tracking continues without
          location rollups.
        </p>
      </section>
    </main>
  );
}
