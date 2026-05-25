import Link from "next/link";
import { HeroAuditForm } from "@/components/hero-audit-form";
import { OrganizationJsonLd, SoftwareApplicationJsonLd, FaqJsonLd } from "@/components/json-ld";
import { PerformancePreview } from "@/components/report/performance-preview";
import { env } from "@/lib/env";

const faqs = [
  {
    q: "What does CrawlProof actually check?",
    a: "We fetch your site as both an HTML-only crawler and as a JS-rendered browser, then audit content visibility, schema/JSON-LD, robots and sitemaps, AI-bot rules, llms.txt and skill.md, and positioning clarity. You get a prioritized to-do list.",
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
    q: "Is the free tier really free?",
    a: "Yes — anonymous visitors get 10 audits per day per IP with no signup, and signing up unlocks 3 free credits. Paid scans are $1/credit with volume discounts down to $0.50/credit at 100 scans. No subscription, credits never expire.",
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
          AEO audit · ChatGPT · Claude · Perplexity · Google AI Overviews
        </p>
        <h1 className="text-balance text-4xl font-extrabold leading-tight sm:text-5xl md:text-6xl">
          See your site the way AI crawlers do.
        </h1>
        <p className="mx-auto mt-5 max-w-2xl text-lg text-[var(--color-muted)]">
          CrawlProof runs an AEO audit on any URL and tells you what LLMs can actually find —
          content, schema, robots rules, AI-bot access, and positioning. Free,
          no signup needed to try.
        </p>
        <div className="mx-auto mt-8 max-w-xl">
          <HeroAuditForm />
        </div>
        <p className="mx-auto mt-3 max-w-xl text-xs leading-relaxed text-[var(--color-muted)]">
          Enter a URL to generate an on-page rule-based report. Add email only
          if you want the PDF delivered to your inbox. No card required.
        </p>
      </section>

      <section className="mx-auto max-w-6xl px-4 sm:px-6 pb-16">
        <h2 className="mb-8 text-center text-2xl font-bold">What we check</h2>
        <div className="grid gap-4 md:grid-cols-3">
          <FeatureCard
            title="Crawlability"
            body="Raw HTML vs. JS-rendered diff, sitemap coverage, robots rules, fetch-time, broken links."
          />
          <FeatureCard
            title="Structured data"
            body="JSON-LD presence and validity for Organization, Product, FAQ, Article, Breadcrumb, and more."
          />
          <FeatureCard
            title="AI-bot access"
            body="Whether GPTBot, ClaudeBot, PerplexityBot, Google-Extended, OAI-SearchBot, Applebot-Extended, and CCBot can read you."
          />
          <FeatureCard
            title="llms.txt + skill.md"
            body="The two new files AI crawlers look for. We check both, and tell you what to put in them."
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
          Save URLs as projects and CrawlProof tracks AEO score, finding mix, section health,
          and priority backlog across every re-audit — the same dashboard you&apos;ll see on any paid report.
        </p>
        <PerformancePreview variant="home" />
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
              Each published post uses 1 credit.
            </p>
            <div className="mt-6 grid gap-3 sm:grid-cols-3">
              <LaunchStat label="Cost model" value="1 credit" />
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
      aria-label="Backlink marketplace examples ranged from $445 to $4,090, compared with CrawlProof Autoblog at 1 credit per post."
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
          <div className="font-mono text-lg font-bold text-[var(--color-accent)]">1 credit</div>
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
          <div className="font-mono text-lg font-bold text-[var(--color-accent)]">1 credit</div>
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
