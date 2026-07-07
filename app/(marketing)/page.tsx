import Link from "next/link";
import { HeroAuditForm } from "@/components/hero-audit-form";
import { OrganizationJsonLd, SoftwareApplicationJsonLd, FaqJsonLd } from "@/components/json-ld";
import { PerformancePreview } from "@/components/report/performance-preview";
import { UptimePreview } from "@/components/report/uptime-preview";
import { SecurityPreview } from "@/components/report/security-preview";
import { env } from "@/lib/env";

const faqs = [
  {
    q: "How does the ad network work?",
    a: "It's two-sided and crypto-settled. Advertisers give a landing-page URL and CrawlProof auto-designs on-brand display ads (edit the copy/colours or upload your own), then run them across the network for a daily budget paid from credits. Publishers opt a verified project in as an ad slot, drop one tag (or open an install PR), and earn a share of every click — paid on-chain to their wallet via CoinPay. Bot and duplicate clicks are filtered so they never bill.",
  },
  {
    q: "What does CrawlProof actually check?",
    a: "We audit three pillars: SEO (crawlability, performance, meta), AEO (AI-bot access, structured data, content snippet-readiness), and GEO (llms.txt quality, knowledge graph sameAs links, AI agent integration, brand entity clarity). You get a single prioritized to-do list covering all three.",
  },
  {
    q: "Which AI crawlers do you check for?",
    a: "GPTBot, ClaudeBot, PerplexityBot, Google-Extended, OAI-SearchBot, Applebot-Extended, and CCBot — and we flag any that your robots.txt blocks or fails to address.",
  },
  {
    q: "Do you respect robots.txt?",
    a: "Yes. CrawlProofBot identifies itself and honors robots.txt directives that block it. We never log in, never submit forms, never POST.",
  },
  {
    q: "What can CrawlProof monitor for uptime?",
    a: "HTTP(S) status and response time, a keyword that must appear (or not) in the page body, SSL-certificate expiry, and raw TCP ports. We confirm failures across multiple checks before alerting (no flapping), then email you on both downtime and recovery — with the exact outage duration.",
  },
  {
    q: "How does the exposed-services security scan work?",
    a: "For hosts you've verified you own, CrawlProof runs a full 65,535-port TCP scan from a dedicated scanner, baselines the ports you expect to be open, and alerts you when a new one appears — e.g. a database or admin port suddenly reachable from the public internet. It's attack-surface drift detection, only ever against your own verified hosts.",
  },
  {
    q: "Is the free tier really free?",
    a: "Yes — anonymous visitors get 10 audits per day per IP with no signup, and signing up unlocks 20 free credits (1 AI-model scan). Paid scans cost 20 credits (~$1) with volume discounts down to $0.50/scan at the 100-scan pack. No subscription, credits never expire.",
  },
];

const backlinkPricePoints = [
  { label: "Entry", value: "$445", width: 11 },
  { label: "Alt", value: "$445", width: 11 },
  { label: "Low", value: "$506", width: 12 },
  { label: "Mid", value: "$631", width: 15 },
  { label: "Plus", value: "$1,105", width: 27 },
  { label: "High", value: "$1,331", width: 33 },
  { label: "Upper", value: "$1,981", width: 48 },
  { label: "Peak", value: "$4,090", width: 100 },
];

export default function HomePage() {
  return (
    <main>
      <OrganizationJsonLd />
      <SoftwareApplicationJsonLd />
      <FaqJsonLd faqs={faqs} />

      <section className="mx-auto max-w-4xl px-4 sm:px-6 pb-12 pt-12 sm:pb-16 sm:pt-20 text-center">
        <p className="mb-3 text-sm font-medium uppercase tracking-wider text-[var(--color-accent)]">
          Audits · Uptime · Security · Content — one platform for your site
        </p>
        <h1 className="text-balance text-4xl font-extrabold leading-tight sm:text-5xl md:text-6xl">
          Get found by AI. Stay online. Stay secure.
        </h1>
        <p className="mx-auto mt-5 max-w-2xl text-lg text-[var(--color-muted)]">
          CrawlProof started by showing you your site the way{" "}
          <strong className="font-semibold text-[var(--color-text)]">
            AI crawlers
          </strong>{" "}
          do — SEO, AEO &amp; GEO audits for ChatGPT, Claude, Perplexity, and
          Google AI Overviews. Now it&apos;s a full platform: <strong className="font-semibold text-[var(--color-text)]">uptime
          monitoring</strong> with downtime alerts, <strong className="font-semibold text-[var(--color-text)]">exposed-services
          security scans</strong>, automated content, backlinks, and analytics —
          all from one dashboard. Start with a free audit:
        </p>
        <div className="mx-auto mt-8 max-w-xl">
          <HeroAuditForm />
        </div>
        <div className="mx-auto mt-4 flex max-w-xl flex-col items-center gap-3 text-xs text-[var(--color-muted)]">
          <p className="leading-relaxed">
            Every scan checks crawlability (HTML vs. JS-rendered), schema /
            JSON-LD, robots.txt &amp; sitemap, AI-bot access, llms.txt &amp;
            skill.md, and positioning — then hands you a priority to-do list.
          </p>
          {env.selfAuditUrl && (
            <a
              href={env.selfAuditUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="font-semibold text-[var(--color-accent)] hover:underline"
            >
              See a sample report →
            </a>
          )}
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 sm:px-6 pb-16">
        <h2 className="mb-2 text-center text-2xl font-bold">One platform, every angle</h2>
        <p className="mx-auto mb-8 max-w-2xl text-center text-sm text-[var(--color-muted)]">
          Everything you need to get discovered, stay online, and stay secure — no
          separate subscriptions for monitoring, security, and content.
        </p>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <ModuleCard emoji="🔍" title="SEO · AEO · GEO Audits" body="See your site the way ChatGPT, Claude, Perplexity, and Google AI crawlers do — with a priority to-do list." />
          <ModuleCard emoji="📈" title="Uptime Monitoring" body="HTTP, keyword, SSL &amp; TCP checks with instant down/recovery alerts to email, Slack, and Discord." />
          <ModuleCard emoji="🛡️" title="Exposed Services" body="Full-port security scans of your verified hosts — get alerted the moment a database or admin port is exposed." />
          <ModuleCard emoji="✍️" title="Autoblog" body="Research, draft, illustrate, and publish long-form SEO posts to your CMS on a schedule — ~$1 each." />
          <ModuleCard emoji="🔗" title="Link Exchange" body="Verified backlink matching with a real ledger — quality links without four-figure marketplace prices." />
          <ModuleCard emoji="📊" title="Analytics Tracker" body="A drop-in tracker for AI referrals, bot crawls, human traffic, pages, and geo — see who (and what) visits." />
          <ModuleCard emoji="📣" title="Social Posting" body="Draft and schedule social posts and feed autoposts alongside your content pipeline." />
          <ModuleCard emoji="🐙" title="GitHub Fixes" body="Bind a repo and turn audit findings into ready-to-merge pull requests." />
          <ModuleCard emoji="🪧" title="Ad Network" body="Promote your site across the network for a daily budget, or show ads and earn crypto — auto-designed, on-brand creatives from just a URL." />
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 sm:px-6 pb-16">
        <h2 className="mb-2 text-center text-2xl font-bold">What we check</h2>
        <p className="mx-auto mb-8 max-w-2xl text-center text-sm text-[var(--color-muted)]">
          Three pillars — SEO (blue-link search), AEO (answer engines), and GEO (generative AI
          citation) — unified in a single audit and priority to-do list.
        </p>
        <div className="grid gap-4 md:grid-cols-3">
          <FeatureCard
            title="Crawlability (SEO)"
            body="Raw HTML vs. JS-rendered diff, sitemap coverage, robots rules, fetch-time, broken links."
          />
          <FeatureCard
            title="Structured data (AEO)"
            body="JSON-LD presence and validity for Organization, Product, FAQ, Article, Breadcrumb, and more."
          />
          <FeatureCard
            title="AI-bot access (AEO)"
            body="Whether GPTBot, ClaudeBot, PerplexityBot, Google-Extended, OAI-SearchBot, Applebot-Extended, and CCBot can read you."
          />
          <FeatureCard
            title="llms.txt quality (GEO)"
            body="Existence is not enough — we check depth, sections, and linked resources so generative AI has rich context to cite."
          />
          <FeatureCard
            title="Knowledge graph (GEO)"
            body="Does your Organization schema have sameAs links to Wikipedia, Wikidata, or LinkedIn? AI needs these to resolve your brand as a known entity."
          />
          <FeatureCard
            title="Agent integration (GEO)"
            body="ai-plugin.json, agent-card.json, and skill.md let AI agents interact with your site. We check all three."
          />
          <FeatureCard
            title="Positioning clarity"
            body="Does your homepage actually say what you do? H1, value prop, pricing, contact, team."
          />
          <FeatureCard
            title="Priority to-do list"
            body="Every finding ranked 1–5 with copy you can hand straight to your dev or LLM."
          />
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 sm:px-6 pb-16">
        <h2 className="mb-2 text-center text-2xl font-bold">What you get when you sign up</h2>
        <p className="mx-auto mb-8 max-w-2xl text-center text-sm text-[var(--color-muted)]">
          Save URLs as projects and CrawlProof tracks SEO + AEO + GEO score, finding mix,
          section health, and priority backlog across every re-audit — the same dashboard
          you&apos;ll see on any paid report.
        </p>
        <PerformancePreview variant="home" />
      </section>

      <section className="mx-auto max-w-6xl px-4 sm:px-6 pb-16">
        <div className="grid items-center gap-8 lg:grid-cols-[1.05fr_0.95fr]">
          <div>
            <p className="mb-3 text-sm font-medium uppercase tracking-wider text-[var(--color-accent)]">
              Uptime Monitoring
            </p>
            <h2 className="text-balance text-3xl font-extrabold leading-tight sm:text-4xl">
              Know before your customers do.
            </h2>
            <p className="mt-4 text-[var(--color-muted)]">
              Add a monitor in one click — we prefill your domain and URL. CrawlProof
              checks it on your interval and emails you the instant it goes down,
              then again when it recovers, with the exact downtime. HTTP status,
              body keywords, SSL-cert expiry, and raw TCP ports.
            </p>
            <div className="mt-6 grid gap-3 sm:grid-cols-3">
              <LaunchStat label="Checks" value="HTTP · SSL · TCP" />
              <LaunchStat label="Alerts" value="Email · Slack" />
              <LaunchStat label="Confirm" value="No flapping" />
            </div>
            <div className="mt-6 flex flex-wrap gap-3">
              <Link href="/signup" className="btn btn-primary">
                Start monitoring free
              </Link>
            </div>
          </div>
          <UptimePreview />
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 sm:px-6 pb-16">
        <div className="grid items-center gap-8 lg:grid-cols-[0.95fr_1.05fr]">
          <SecurityPreview />
          <div>
            <p className="mb-3 text-sm font-medium uppercase tracking-wider text-[var(--color-accent)]">
              Exposed Services — Security
            </p>
            <h2 className="text-balance text-3xl font-extrabold leading-tight sm:text-4xl">
              Catch the port you forgot to close.
            </h2>
            <p className="mt-4 text-[var(--color-muted)]">
              CrawlProof runs a full 65,535-port scan of your owner-verified hosts,
              baselines what&apos;s expected, and alerts you the moment something{" "}
              <em>new</em> gets exposed — a Redis, a Postgres, an admin panel facing
              the public internet. Attack-surface monitoring, not a one-off scan.
            </p>
            <div className="mt-6 grid gap-3 sm:grid-cols-3">
              <LaunchStat label="Coverage" value="All 65,535" />
              <LaunchStat label="Scope" value="Owned hosts" />
              <LaunchStat label="Alerts on" value="Port drift" />
            </div>
            <div className="mt-6 flex flex-wrap gap-3">
              <Link href="/signup" className="btn btn-primary">
                Scan my services
              </Link>
            </div>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 sm:px-6 pb-16">
        <div className="grid items-center gap-8 lg:grid-cols-[0.95fr_1.05fr]">
          <div>
            <p className="mb-3 text-sm font-medium uppercase tracking-wider text-[var(--color-accent)]">
              Newly Launched Feature
            </p>
            <h2 className="text-balance text-3xl font-extrabold leading-tight sm:text-4xl">
              Autoblog support turns credits into published SEO posts.
            </h2>
            <p className="mt-4 text-[var(--color-muted)]">
              Connect a webhook once and CrawlProof can research topics, draft long-form
              posts, attach a hero image, and deliver articles to your CMS on schedule.
              Each published post uses 20 credits (~$1).
            </p>
            <div className="mt-6 grid gap-3 sm:grid-cols-3">
              <LaunchStat label="Cost model" value="20 credits" />
              <LaunchStat label="Delivery" value="Webhook" />
              <LaunchStat label="Cadence" value="Scheduled" />
            </div>
            <div className="mt-6 flex flex-wrap gap-3">
              <Link href="/signup" className="btn btn-primary">
                Start autoblogging
              </Link>
              <Link href="/docs/autoblog-webhook" className="btn">
                View webhook docs
              </Link>
            </div>
          </div>

          <AutoblogLaunchGraphic />
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 sm:px-6 pb-16">
        <div className="mx-auto max-w-3xl text-center">
          <p className="mb-3 text-sm font-medium uppercase tracking-wider text-[var(--color-accent)]">
            Newly Launched Feature
          </p>
          <h2 className="text-balance text-3xl font-extrabold leading-tight sm:text-4xl">
            A crypto-settled ad network for indie sites.
          </h2>
          <p className="mt-4 text-[var(--color-muted)]">
            Two sides, one dashboard. Advertisers drop in a landing-page URL and CrawlProof
            auto-designs on-brand display ads — edit the copy and colours, or upload your own —
            then set a daily budget. Publishers flip a switch, drop one tag, and earn crypto for
            every click, paid straight to their wallet via CoinPay. No fiat, no middlemen.
          </p>
        </div>
        <div className="mt-8 grid gap-4 md:grid-cols-2">
          <div className="card p-6">
            <div className="text-2xl">📣</div>
            <h3 className="mt-2 text-xl font-bold">Advertise your site</h3>
            <p className="mt-2 text-sm text-[var(--color-muted)]">
              Paste your URL, get instant on-brand banners, fund a daily budget from credits.
              Every click is attributed with your own <code>?ref=</code> tag and metered fairly —
              bots and duplicate clicks never bill.
            </p>
            <div className="mt-5 flex flex-wrap gap-3">
              <Link href="/ads/new" className="btn btn-primary">
                Create an ad
              </Link>
            </div>
          </div>
          <div className="card p-6">
            <div className="text-2xl">🪧</div>
            <h3 className="mt-2 text-xl font-bold">Monetize your site</h3>
            <p className="mt-2 text-sm text-[var(--color-muted)]">
              Opt a verified project in as an ad slot, paste one snippet (or open a PR to install
              it), and pick your payout coin. Earnings accrue per click and withdraw on-chain to
              your wallet — one-click connect on tronbrowser.dev.
            </p>
            <div className="mt-5 flex flex-wrap gap-3">
              <Link href="/ads/slots" className="btn btn-primary">
                Monetize a site
              </Link>
            </div>
          </div>
        </div>
        <div className="mt-6 grid gap-3 sm:grid-cols-3">
          <LaunchStat label="Creatives" value="Auto · on-brand" />
          <LaunchStat label="Settlement" value="Crypto · CoinPay" />
          <LaunchStat label="Billing" value="Bot/dupe-filtered" />
        </div>
      </section>

      <section className="mx-auto max-w-4xl px-4 sm:px-6 pb-16">
        <div className="card p-6 sm:p-8">
          <h2 className="text-2xl font-bold">Built to be audited in public.</h2>
          <p className="mt-2 text-[var(--color-muted)]">
            CrawlProof.com ships server-rendered pages, rich schema, clean robots rules,
            llms.txt, and skill.md at the root. Public scans can vary by model and timing,
            so the product shows the report details instead of hiding behind a single claim.
          </p>
          {env.selfAuditUrl && (
            <a
              href={env.selfAuditUrl}
              className="btn mt-4"
              target="_blank"
              rel="noopener noreferrer"
            >
              View current self-audit
            </a>
          )}
        </div>
      </section>

      <section id="faq" className="mx-auto max-w-3xl px-4 sm:px-6 pb-24">
        <h2 className="mb-8 text-center text-2xl font-bold">FAQ</h2>
        <div className="space-y-3">
          {faqs.map((f) => (
            <details key={f.q} className="card p-5">
              <summary className="cursor-pointer font-semibold">{f.q}</summary>
              <p className="mt-2 text-[var(--color-muted)]">{f.a}</p>
            </details>
          ))}
        </div>
      </section>
    </main>
  );
}

function LaunchStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[rgba(18,22,28,0.72)] p-4">
      <div className="text-xs uppercase tracking-wider text-[var(--color-muted)]">{label}</div>
      <div className="mt-1 text-lg font-bold">{value}</div>
    </div>
  );
}

function AutoblogLaunchGraphic() {
  return (
    <div
      className="rounded-xl border border-[var(--color-border)] bg-[#101820] p-5 shadow-2xl shadow-black/20 sm:p-6"
      aria-label="Backlink marketplace examples ranged from $445 to $4,090, compared with CrawlProof Autoblog at 20 credits (~$1) per post."
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
            Generic market spread
          </div>
          <div className="mt-1 text-xl font-extrabold">Backlink prices found in research</div>
        </div>
        <div className="rounded-lg border border-[rgba(110,231,183,0.35)] bg-[rgba(110,231,183,0.12)] px-3 py-2 text-right">
          <div className="text-xs text-[var(--color-muted)]">Autoblog</div>
          <div className="font-mono text-lg font-bold text-[var(--color-accent)]">~$1</div>
        </div>
      </div>

      <div className="mt-6 space-y-3">
        {backlinkPricePoints.map((point) => (
          <div key={`${point.label}-${point.value}`} className="grid grid-cols-[3.4rem_1fr_4.4rem] items-center gap-3">
            <div className="text-xs text-[var(--color-muted)]">{point.label}</div>
            <div className="h-3 rounded-full bg-[#1d2630]">
              <div
                className="h-3 rounded-full bg-[linear-gradient(90deg,#6ee7b7,#fbbf24)]"
                style={{ width: `${point.width}%` }}
              />
            </div>
            <div className="text-right font-mono text-sm font-semibold">{point.value}</div>
          </div>
        ))}
      </div>

      <div className="mt-6 grid gap-3 sm:grid-cols-3">
        <div className="rounded-lg bg-[#17202a] p-3">
          <div className="text-xs text-[var(--color-muted)]">Min observed</div>
          <div className="font-mono text-lg font-bold">$445</div>
        </div>
        <div className="rounded-lg bg-[#17202a] p-3">
          <div className="text-xs text-[var(--color-muted)]">Max observed</div>
          <div className="font-mono text-lg font-bold">$4,090</div>
        </div>
        <div className="rounded-lg bg-[#17202a] p-3">
          <div className="text-xs text-[var(--color-muted)]">CrawlProof</div>
          <div className="font-mono text-lg font-bold text-[var(--color-accent)]">~$1</div>
        </div>
      </div>

      <p className="mt-4 text-xs leading-relaxed text-[var(--color-muted)]">
        Price examples are redrawn from internal reference research as an abstract comparison,
        not a copied marketplace interface.
      </p>
    </div>
  );
}

function FeatureCard({ title, body }: { title: string; body: string }) {
  return (
    <div className="card p-5">
      <h3 className="font-semibold">{title}</h3>
      <p className="mt-2 text-sm text-[var(--color-muted)]">{body}</p>
    </div>
  );
}

function ModuleCard({ emoji, title, body }: { emoji: string; title: string; body: string }) {
  return (
    <div className="card flex flex-col p-5">
      <div className="text-2xl" aria-hidden>
        {emoji}
      </div>
      <h3 className="mt-2 font-semibold">{title}</h3>
      <p className="mt-1 text-sm text-[var(--color-muted)]">{body}</p>
    </div>
  );
}
