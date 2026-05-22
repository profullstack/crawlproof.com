import Link from "next/link";

export const metadata = {
  title: "Stats tracker",
  description:
    "Drop-in <script> tag for CrawlProof's stats tracker — see which AI engines refer your site and which AI crawlers visit, with no cookies and no PII.",
  alternates: { canonical: "/docs/stats-tracker" },
};

export default function StatsTrackerDocsPage() {
  return (
    <main className="mx-auto max-w-3xl px-4 py-16 sm:px-6">
      <p className="text-sm">
        <Link href="/docs" className="text-[var(--color-muted)] hover:underline">
          ← Docs
        </Link>
      </p>
      <h1 className="mt-2 text-4xl font-extrabold">Stats tracker</h1>
      <p className="mt-3 text-[var(--color-muted)]">
        The <strong>CrawlProof stats tracker</strong> is a one-line drop-in
        that counts where your visitors come from — with first-class
        buckets for the AI engines that refer you (ChatGPT, Perplexity,
        Claude, Gemini, Copilot, You, Phind, Kagi) and the AI crawlers
        that visit (GPTBot, ClaudeBot, PerplexityBot, OAI-SearchBot,
        Google-Extended, Applebot-Extended, Bytespider, CCBot…).
      </p>

      <section className="mt-10 space-y-3">
        <h2 className="text-2xl font-bold">Install</h2>
        <p className="text-sm leading-relaxed">
          On the project Stats tab, flip the tracker on. Then paste this
          tag just before the closing <code>&lt;/body&gt;</code> on every
          page you want tracked. The Stats tab gives you the exact tag
          with your project id baked in — this snippet is for reference.
        </p>
        <pre className="overflow-x-auto rounded border border-[var(--color-border)] bg-[#0b0d10] p-3 font-mono text-xs leading-relaxed">{`<script
  data-site="<your-project-id>"
  src="https://crawlproof.com/stats.js"
  async
></script>`}</pre>
        <p className="text-sm leading-relaxed">
          One tag per project. If a single domain spans multiple
          CrawlProof projects, install one tag per project — each page
          can ship multiple tags safely.
        </p>
      </section>

      <section className="mt-10 space-y-3">
        <h2 className="text-2xl font-bold">What we count</h2>
        <p className="text-sm leading-relaxed">
          Every pageview becomes one event. We look at the{" "}
          <code className="font-mono">Referer</code> header and the
          visitor&apos;s <code className="font-mono">User-Agent</code> and
          assign the event to a bucket. The buckets are:
        </p>
        <ul className="list-disc pl-5 text-sm leading-relaxed">
          <li>
            <code className="font-mono">ai_referral:&lt;source&gt;</code> —
            chatgpt, perplexity, claude, gemini, copilot, you, phind, kagi,
            duckduckgo_ai
          </li>
          <li>
            <code className="font-mono">bot:&lt;name&gt;</code> — gptbot,
            oai_searchbot, chatgpt_user, claudebot, claude_web, perplexitybot,
            perplexity_user, google_extended, applebot_extended, bytespider,
            ccbot, cohere, meta_external, plus other bots/crawlers
          </li>
          <li>
            <code className="font-mono">search:&lt;engine&gt;</code> —
            google, bing, yahoo, yandex, baidu, ecosia, brave
          </li>
          <li>
            <code className="font-mono">social:&lt;platform&gt;</code> —
            twitter, facebook, linkedin, reddit, hackernews, youtube,
            github, discord, telegram
          </li>
          <li>
            <code className="font-mono">referral:&lt;host&gt;</code> — any
            other inbound referrer, keyed by hostname
          </li>
          <li>
            <code className="font-mono">human:direct</code> — no referrer
            and no bot UA
          </li>
        </ul>
        <p className="text-sm leading-relaxed">
          Counts roll up by day. Storage is one row per{" "}
          <code className="font-mono">(project_id, day, bucket)</code> —
          a million pageviews a day on a hundred buckets is still a
          hundred rows.
        </p>
      </section>

      <section className="mt-10 space-y-3">
        <h2 className="text-2xl font-bold">Privacy &amp; payload</h2>
        <ul className="list-disc pl-5 text-sm leading-relaxed">
          <li>No cookies. No localStorage. No fingerprinting.</li>
          <li>
            No IP address stored. The categorization is purely{" "}
            <code className="font-mono">Referer</code> +{" "}
            <code className="font-mono">User-Agent</code>.
          </li>
          <li>
            Client payload is just <code>{`{ site, ref, path }`}</code>.
            The UA is read server-side from the request header.
          </li>
          <li>
            Path is captured so future versions can break down per page —
            today it&apos;s ignored at aggregation time.
          </li>
          <li>
            Best-effort: a failed POST never blocks or errors the host
            page. The snippet wraps everything in try/catch.
          </li>
        </ul>
      </section>

      <section className="mt-10 space-y-3">
        <h2 className="text-2xl font-bold">SPA pageviews</h2>
        <p className="text-sm leading-relaxed">
          The snippet hooks{" "}
          <code className="font-mono">history.pushState</code> /{" "}
          <code className="font-mono">replaceState</code> and{" "}
          <code className="font-mono">popstate</code>, so client-side
          routes count too. Same-path replays are deduped within a
          session.
        </p>
      </section>

      <section className="mt-10 space-y-3">
        <h2 className="text-2xl font-bold">Billing</h2>
        <p className="text-sm leading-relaxed">
          Tracker is opt-in per project. Pricing is{" "}
          <strong>1 credit per active site per month</strong>, deducted
          from your CrawlProof credit balance on the day you enable it
          and again on each monthly rollover. Disable from the Stats tab
          to stop the meter — re-enabling starts a fresh month.
        </p>
      </section>

      <p className="mt-10 text-sm text-[var(--color-muted)]">
        Questions or want a bucket added?{" "}
        <a className="underline" href="mailto:hello@crawlproof.com">
          hello@crawlproof.com
        </a>
        .
      </p>
    </main>
  );
}
