import { HeroAuditForm } from "@/components/hero-audit-form";
import { OrganizationJsonLd, SoftwareApplicationJsonLd, FaqJsonLd } from "@/components/json-ld";

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
          content, schema, robots rules, AI-bot access, and positioning. Free, no signup needed to try.
        </p>
        <div className="mx-auto mt-8 max-w-xl">
          <HeroAuditForm />
        </div>
        <p className="mt-3 text-xs text-[var(--color-muted)]">
          10 free audits per day from this IP. No card required.
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

      <section className="mx-auto max-w-4xl px-4 sm:px-6 pb-16">
        <div className="card p-6 sm:p-8">
          <h2 className="text-2xl font-bold">Built to pass its own audit.</h2>
          <p className="mt-2 text-[var(--color-muted)]">
            CrawlProof.com itself scores 100/100. Server-rendered, schema-rich, robots-clean,
            with llms.txt and skill.md at the root.
          </p>
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

function FeatureCard({ title, body }: { title: string; body: string }) {
  return (
    <div className="card p-5">
      <h3 className="font-semibold">{title}</h3>
      <p className="mt-2 text-sm text-[var(--color-muted)]">{body}</p>
    </div>
  );
}
