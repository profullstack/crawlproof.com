import type { Metadata } from "next";
import { HeroAuditForm } from "@/components/hero-audit-form";
import { ANON_DAILY_SCANS } from "@/lib/credits";
import { OrganizationJsonLd, SoftwareApplicationJsonLd, FaqJsonLd } from "@/components/json-ld";
import { MonitorPlans, MONITOR_PAYMENT_NOTE } from "@/components/monitor-plans";
import { env } from "@/lib/env";

// The homepage sells one thing during the 30-day validation test
// (prd/validation-30d.md): the free AI-visibility audit, and weekly
// monitoring as the paid next step. Every other product still works at its
// own URL; it is just not pitched here.

const faqs = [
  {
    q: "What does the audit check?",
    a: "Whether AI crawlers can read the site (GPTBot, ClaudeBot, PerplexityBot, Google-Extended and others), what the raw HTML shows before JavaScript runs, structured data, robots.txt and sitemap, llms.txt, knowledge-graph links and how clearly the homepage says what the business does. Every finding is ranked so the top fixes come first.",
  },
  {
    q: "Is the audit really free?",
    a: `Yes. No account, no card: ${ANON_DAILY_SCANS} audits a day per visitor. Every audit gets a permanent link you can forward to a developer or a client.`,
  },
  {
    q: "What does weekly monitoring add?",
    a: "The same audit re-run every week on each site you add, and an email when a score moves, with a link to the new report. A deploy that blocks GPTBot or breaks the schema shows up in days instead of months.",
  },
  {
    q: "Who is the Agency plan for?",
    a: "SEO and marketing agencies managing client sites. $199 a month covers up to 20 sites, and every run has a shareable report you can send the client.",
  },
  {
    q: "How do I pay, and how do I cancel?",
    a: "By card through PayPal, or in crypto, on CoinPay's checkout page. Each month is paid up front and nothing renews by itself: you get a link a few days before the month ends. Cancel from your dashboard at any time.",
  },
  {
    q: "Do you respect robots.txt?",
    a: "Yes. CrawlProofBot identifies itself and honours robots.txt rules that block it. It never logs in, never submits forms and never POSTs.",
  },
];

const checks = [
  {
    title: "AI-bot access",
    body: "Whether GPTBot, ClaudeBot, PerplexityBot, Google-Extended, OAI-SearchBot, Applebot-Extended and CCBot can read the site.",
  },
  {
    title: "Crawlability",
    body: "Raw HTML against the JavaScript-rendered page, sitemap coverage, robots rules, fetch time and broken links.",
  },
  {
    title: "Structured data",
    body: "JSON-LD presence and validity for Organization, Product, FAQ, Article, Breadcrumb and more.",
  },
  {
    title: "llms.txt and agent files",
    body: "llms.txt depth and links, plus ai-plugin.json, agent-card.json and skill.md for AI agents.",
  },
  {
    title: "Knowledge graph",
    body: "sameAs links to Wikipedia, Wikidata or LinkedIn, which AI needs to recognise the brand as a known entity.",
  },
  {
    title: "Positioning",
    body: "Does the homepage say what the business does? H1, value proposition, pricing, contact.",
  },
];

// ad.network verifies the site by fetching this page's raw HTML for the code.
const AD_NETWORK_CODE = "g9SV_eEnRTTJXx8V";

export const metadata: Metadata = {
  other: { "ad.network": AD_NETWORK_CODE },
};

export default function HomePage() {
  return (
    <main>
      <OrganizationJsonLd />
      <SoftwareApplicationJsonLd />
      <FaqJsonLd faqs={faqs} />

      <section id="audit" className="mx-auto max-w-4xl scroll-mt-24 px-4 pb-12 pt-12 text-center sm:px-6 sm:pb-16 sm:pt-20">
        <p className="mb-3 text-sm font-medium uppercase tracking-wider text-[var(--color-accent)]">
          Free AI-visibility audit
        </p>
        <h1 className="text-balance text-4xl font-extrabold leading-tight sm:text-5xl md:text-6xl">
          Can ChatGPT, Claude and Perplexity find your site?
        </h1>
        <p className="mx-auto mt-5 max-w-2xl text-lg text-[var(--color-muted)]">
          Enter a URL. In under a minute you get a score out of 100, the fixes that matter most,
          and a report link you can send to whoever makes the changes. No signup.
        </p>
        <div className="mx-auto mt-8 max-w-xl">
          <HeroAuditForm />
        </div>
        {env.selfAuditUrl && (
          <p className="mt-4 text-xs">
            <a
              href={env.selfAuditUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="font-semibold text-[var(--color-accent)] hover:underline"
            >
              See a sample report →
            </a>
          </p>
        )}
      </section>

      <section className="mx-auto max-w-6xl px-4 pb-16 sm:px-6">
        <h2 className="mb-2 text-center text-2xl font-bold">What the audit checks</h2>
        <p className="mx-auto mb-8 max-w-2xl text-center text-sm text-[var(--color-muted)]">
          Everything an AI crawler needs to read, understand and cite a site, in one ranked list.
        </p>
        <div className="grid gap-4 md:grid-cols-3">
          {checks.map((c) => (
            <div key={c.title} className="card p-5">
              <h3 className="font-semibold">{c.title}</h3>
              <p className="mt-2 text-sm text-[var(--color-muted)]">{c.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section id="monitoring" className="mx-auto max-w-4xl scroll-mt-24 px-4 pb-16 sm:px-6">
        <h2 className="mb-2 text-center text-2xl font-bold">Then keep it that way: weekly monitoring</h2>
        <p className="mx-auto mb-8 max-w-2xl text-center text-[var(--color-muted)]">
          A deploy, a new robots.txt rule or a broken schema block can hide a site from AI answers
          without anyone noticing. Monitoring re-runs the audit every week and emails you when
          the score moves. Agencies can watch every client site and send each client its report.
        </p>
        <MonitorPlans />
        <p className="mt-4 text-center text-sm text-[var(--color-muted)]">{MONITOR_PAYMENT_NOTE}</p>
      </section>

      <section className="mx-auto max-w-4xl px-4 pb-16 text-center sm:px-6">
        <a href="#audit" className="btn btn-primary">
          Run a free audit
        </a>
      </section>

      <section id="faq" className="mx-auto max-w-3xl px-4 pb-24 sm:px-6">
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
