import Link from "next/link";
import {
  LEAD_RUN_CREDITS,
  OUTREACH_CREDITS,
  SCAN_CREDITS,
  CREDIT_RACK_CENTS,
  dollars,
} from "@/lib/credits";
import { MONITOR_PLANS, priceLabel } from "@/lib/monitoring";
import { TRIAL_CREDITS, TRIAL_DAYS } from "@/lib/trial";
import { INTENT_SWEEP_CREDITS, REPLY_DRAFT_CREDITS, TIER_HINTS, TIER_LABELS } from "@/lib/intent/tiers";
import { INTENT_SOURCES } from "@/lib/outreach/intentSources";

export const metadata = {
  title: "Products",
  description: `Everything CrawlProof does, in one place: buyer-intent lead search, AI-visibility audits, weekly monitoring, lead generation, autoblog, ads, analytics and more. Every paid feature is free for ${TRIAL_DAYS} days, no card required.`,
  alternates: { canonical: "/products" },
  openGraph: {
    title: "Products · CrawlProof",
    description: `Every paid CrawlProof feature, free for ${TRIAL_DAYS} days. No card required.`,
    url: "/products",
  },
};

type Pricing = "free" | "trial" | "credits" | "plan";

type Product = {
  id: string;
  name: string;
  pricing: Pricing;
  price: string;
  headline: string;
  body: string;
  bullets: string[];
  href: string;
  cta: string;
  more?: { href: string; label: string };
  isNew?: boolean;
};

const PRICING_BADGE: Record<Pricing, { label: string; cls: string }> = {
  free: { label: "Free", cls: "badge badge-pass" },
  trial: { label: `Free ${TRIAL_DAYS}-day trial`, cls: "badge badge-warn" },
  credits: { label: `Credits · free ${TRIAL_DAYS} days`, cls: "badge badge-warn" },
  plan: { label: `Plan · free ${TRIAL_DAYS} days`, cls: "badge badge-warn" },
};

const credits = (n: number) => `${n} credit${n === 1 ? "" : "s"} (~${dollars(n * CREDIT_RACK_CENTS)})`;

const PRODUCTS: Product[] = [
  {
    id: "buyer-intent",
    name: "Buyer Intent",
    isNew: true,
    pricing: "credits",
    price: `${credits(INTENT_SWEEP_CREDITS)} a sweep · reply drafts ${REPLY_DRAFT_CREDITS} credit`,
    headline: "Find buyers who are asking for what you sell",
    body: "Track your keywords and competitors across public communities. CrawlProof throws away the noise, ranks what is left by buying intent, and drafts a reply you post yourself.",
    bullets: [
      `${INTENT_SOURCES.length} community groups: Reddit, Hacker News, Stack Overflow, GitHub issues, Indie Hackers, Product Hunt, Lobsters, Quora, X, LinkedIn, Mastodon, Bluesky, G2, Capterra and more`,
      "Every lead tagged Hot lead, Worth engaging or Monitor, with the reason it scored",
      "Competitor tracking: \"alternative to\", switching and comparison threads",
      "AI reply drafts in your voice. No social logins, never posts for you",
      "Alerts to Slack, Discord, email digests and HMAC-signed webhooks (Zapier, Make, n8n, HubSpot, Sheets)",
      "CSV export, REST API, CLI and MCP",
    ],
    href: "/signup?redirect=/dashboard/intent",
    cta: "Find my first leads",
    more: { href: "#buyer-intent-how", label: "How it works" },
  },
  {
    id: "audit",
    name: "AI-visibility audit",
    pricing: "free",
    price: `Rule-based scans free · AI-model scans ${credits(SCAN_CREDITS)}`,
    headline: "See how AI answer engines read your site",
    body: "An AEO audit of what ChatGPT, Claude, Perplexity and Google's AI see when they crawl you, with a score, the failing checks and how to fix each one.",
    bullets: [
      "Free rule-based and DNS checks, no signup",
      "AI-model scans that ask the engines themselves",
      "Shareable report links and PDF export",
      "One-click fix pull requests through the GitHub app",
    ],
    href: "/",
    cta: "Run a free audit",
    more: { href: "/pricing", label: "Scan pricing" },
  },
  {
    id: "monitoring",
    name: "Weekly monitoring",
    pricing: "plan",
    price: `Solo ${priceLabel(MONITOR_PLANS.solo.amountCents)}/mo · Agency ${priceLabel(MONITOR_PLANS.agency.amountCents)}/mo`,
    headline: "Know the week your AI visibility moves",
    body: "Your audit re-runs every week and you get an email when a score changes. Trial accounts get Solo monitoring free until the trial ends.",
    bullets: [
      "Solo: one site, Agency: up to 20 client sites",
      "Score-change emails and a report link per run",
      "Pay by card through PayPal or crypto; nothing renews by itself",
    ],
    href: "/signup?redirect=/dashboard/monitoring",
    cta: "Start free monitoring",
    more: { href: "/monitor", label: "Monitoring details" },
  },
  {
    id: "lead-generation",
    name: "Lead generation & outreach",
    pricing: "credits",
    price: `${credits(LEAD_RUN_CREDITS)} a run · ${credits(OUTREACH_CREDITS)} a manual send`,
    headline: "The boring half of cold outreach, done for you",
    body: "Point a campaign at a directory or a search. CrawlProof finds the companies, the people and the addresses, then drafts the email from your own mailbox, grounded in facts you supply.",
    bullets: [
      "Intent-first: people who already asked rank ahead of lookalikes",
      "Contact ladder from the site itself before any paid search",
      "Reply reading, suppression and open tracking that admits its error bars",
    ],
    href: "/signup?redirect=/dashboard",
    cta: "Start a campaign",
    more: { href: "/lead-generation", label: "How campaigns work" },
  },
  {
    id: "autoblog",
    name: "Autoblog",
    pricing: "credits",
    price: `${credits(SCAN_CREDITS)} a published post`,
    headline: "Researched, illustrated posts on your own blog",
    body: "Long-form articles written from keyword research, illustrated, internally linked and published to your site on a schedule, plus guest posts and link exchange across the network.",
    bullets: ["Keyword and buyer-journey research", "Internal linking and hero images", "Webhook delivery to any CMS"],
    href: "/signup?redirect=/dashboard/autoblog",
    cta: "Set up autoblog",
    more: { href: "/docs", label: "Webhook docs" },
  },
  {
    id: "promote",
    name: "Promote",
    pricing: "credits",
    price: `${credits(OUTREACH_CREDITS)} a post`,
    headline: "Share every new post where your audience is",
    body: "Connect your feeds and accounts once; new posts are pitched and published to Bluesky, Mastodon, LinkedIn, Reddit and more, at most once each.",
    bullets: ["Feed-driven, no copy-pasting", "Per-network pitch written for that network", "OAuth only, no password sharing"],
    href: "/signup?redirect=/dashboard/promote",
    cta: "Connect a feed",
  },
  {
    id: "ads",
    name: "Ads & ad network",
    pricing: "credits",
    price: "Flat cost-per-click, no minimum spend",
    headline: "Run ads, or earn from them",
    body: "Paste a landing page and get on-brand creative with built-in A/B tests, or drop one tag on your site and earn crypto for clicks.",
    bullets: ["Auto-generated creative, light and dark", "Autobid and trending-topic targeting", "Publisher payouts to your wallet"],
    href: "/ads",
    cta: "See ads",
  },
  {
    id: "analytics",
    name: "Analytics that separates humans from bots",
    pricing: "free",
    price: "Free tracker",
    headline: "Count people, not crawlers",
    body: "A drop-in stats tracker that splits human visitors from training bots, headless swarms and stale user agents, with an ROI dashboard that joins traffic to revenue.",
    bullets: ["Human visitors vs pageviews, honestly", "Bot and swarm classification", "Stats over API and CLI"],
    href: "/signup?redirect=/dashboard/analytics",
    cta: "Add the tracker",
    more: { href: "/docs", label: "Tracker docs" },
  },
  {
    id: "alerts",
    name: "Alerts",
    pricing: "free",
    price: "Free",
    headline: "Email alerts for anything Google can see",
    body: "Brand mentions, new backlinks, buying-intent searches and more, near-realtime.",
    bullets: ["Build one without signing in", "Backlink and brand categories", "Deduplicated, one email per real change"],
    href: "/alerts",
    cta: "Build an alert",
  },
  {
    id: "trending",
    name: "Trending problems",
    pricing: "free",
    price: "Free",
    headline: "What people are writing about more this week",
    body: "Subjects independent blogs and news sites cover more than last week, measured across hundreds of thousands of feeds. Write the post before everyone else does.",
    bullets: ["Updated daily", "Feeds ad and content targeting", "Public list, API and MCP"],
    href: "/trending",
    cta: "See what is trending",
  },
  {
    id: "tools",
    name: "Free tools",
    pricing: "free",
    price: "Free, no account",
    headline: "Scanners you can run right now",
    body: "AEO audit, Slop Score, DNS analyzer, link checker and the specification.website checklist.",
    bullets: ["No signup", "No LLM guesswork in the rule-based ones", "Shareable results"],
    href: "/tools",
    cta: "Open the tools",
  },
  {
    id: "affiliate",
    name: "Affiliate program",
    pricing: "free",
    price: "Earn 30% for 30 days",
    headline: "Send people to CrawlProof, get paid in crypto",
    body: "Public terms, one link parameter, and payouts straight to your wallet. You can also join other programs from the same dashboard.",
    bullets: ["Open terms file", "Wallet payouts, nobody in between", "Join other OpenAffiliate programs"],
    href: "/affiliate",
    cta: "Become an affiliate",
  },
];

const EXAMPLE_LEADS = [
  { source: "Reddit · r/SaaS", text: "We are outgrowing spreadsheets. What onboarding tool are you using with a Slack integration?", tier: "hot" as const, score: 94 },
  { source: "LinkedIn", text: "Budget approved for Q3. Shortlisting an onboarding tool, demos next week.", tier: "hot" as const, score: 86 },
  { source: "Hacker News", text: "Anyone moved off Acme? Their per-seat pricing is killing us at 40 users.", tier: "engage" as const, score: 71 },
  { source: "Stack Exchange", text: "How do I check if a domain is on an email blocklist? Is there a free API?", tier: "monitor" as const, score: 32 },
];

const TIER_BADGE = { hot: "badge badge-fail", engage: "badge badge-warn", monitor: "badge badge-unknown" } as const;

const INTEGRATIONS = [
  ["Slack", "Instant lead alerts in a channel"],
  ["Discord", "Lead and competitor feeds in your server"],
  ["Email digest", "New leads after every sweep"],
  ["Signed webhook", "One JSON event per lead, HMAC-SHA256"],
  ["Zapier / Make / n8n", "Catch the webhook, build the rest"],
  ["HubSpot / Pipedrive / Sheets", "Through the webhook or your automation tool"],
  ["CSV export", "Every lead, one click"],
  ["API, CLI, MCP", "crawlproof intent, /api/intent/v1, MCP tools"],
];

const COMPARE: Array<[string, string, string, string]> = [
  ["Where it looks", "The two or three sites you remember", "Whatever the alert tool supports", "Reddit, HN, Stack Exchange, X, LinkedIn, review sites and more in one feed"],
  ["Noise", "You read every post", "Every keyword match: memes, tutorials, job ads", "Job ads, sellers and \"no vendors\" posts dropped before you see them"],
  ["Order", "Whatever you find first", "Newest first", "Highest buying intent first, decaying with age"],
  ["Replying", "From scratch", "From scratch", "An AI draft you edit and post yourself"],
  ["Your effort", "A daily habit across a dozen tabs", "Triage every ping", "Skim the top of one ranked list"],
];

const FAQ: Array<[string, string]> = [
  [
    "What does the free trial include?",
    `Every new account gets ${TRIAL_DAYS} days of the paid features: ${TRIAL_CREDITS} trial credits that are spent before your own on Buyer Intent sweeps, reply drafts, AI-model scans, lead-generation runs, outreach and autoblog posts, plus Solo weekly monitoring for one site. No card is asked for.`,
  ],
  [
    "What happens when the trial ends?",
    "Nothing is charged and nothing renews, because we never took a card. Unused trial credits lapse, your data stays, and you buy credits or a monitoring month only if you want to keep going.",
  ],
  [
    "Does CrawlProof post for me or need my social logins?",
    "Not for Buyer Intent. It reads public posts and drafts replies; you copy the reply and post it from your own account. Promote, which does publish, uses OAuth, never passwords.",
  ],
  [
    "How is Buyer Intent different from Apollo or Sales Navigator?",
    "Contact databases tell you who could buy from filters like role and company size. Buyer Intent finds people saying, in public and recently, that they want what you sell. Many teams use both: find the intent here, then reach the right person.",
  ],
  ["Is there a plan per module?", "No. One credit balance covers the whole platform; only weekly monitoring is a monthly plan."],
];

export default function ProductsPage() {
  return (
    <main className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
      <section className="text-center">
        <p className="mb-3 text-sm font-medium uppercase tracking-wider text-[var(--color-accent)]">Products</p>
        <h1 className="text-4xl font-extrabold sm:text-5xl">Everything CrawlProof does</h1>
        <p className="mx-auto mt-4 max-w-2xl text-lg text-[var(--color-muted)]">
          Find buyers, get seen by AI answer engines, and turn traffic into customers. Every paid feature is free for{" "}
          {TRIAL_DAYS} days.
        </p>
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <Link href="/signup" className="btn btn-primary">
            Start your {TRIAL_DAYS}-day free trial
          </Link>
          <Link href="/pricing" className="btn">
            See pricing
          </Link>
        </div>
        <p className="mt-3 text-sm text-[var(--color-muted)]">No card required · nothing renews · cancel by doing nothing</p>
      </section>

      <nav aria-label="Products" className="mt-12 flex flex-wrap justify-center gap-2 text-sm">
        {PRODUCTS.map((p) => (
          <a key={p.id} href={`#${p.id}`} className="badge">
            {p.name}
            {p.isNew ? " · new" : ""}
          </a>
        ))}
      </nav>

      <section className="mt-12 grid gap-6 md:grid-cols-2">
        {PRODUCTS.map((p) => (
          <article
            key={p.id}
            id={p.id}
            className={`card flex scroll-mt-24 flex-col p-6 ${p.isNew ? "ring-2 ring-[var(--color-accent)] md:col-span-2" : ""}`}
          >
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className={PRICING_BADGE[p.pricing].cls}>{PRICING_BADGE[p.pricing].label}</span>
              {p.isNew && <span className="badge badge-pass">New</span>}
              <span className="text-[var(--color-muted)]">{p.price}</span>
            </div>
            <h2 className="mt-3 text-sm font-semibold uppercase tracking-wider text-[var(--color-muted)]">{p.name}</h2>
            <h3 className="mt-1 text-2xl font-bold">{p.headline}</h3>
            <p className="mt-2 text-[var(--color-muted)]">{p.body}</p>
            <ul className={`mt-4 flex-1 space-y-2 text-sm ${p.isNew ? "sm:columns-2 sm:gap-8" : ""}`}>
              {p.bullets.map((b) => (
                <li key={b} className="flex gap-2 break-inside-avoid">
                  <span aria-hidden className="text-[var(--color-accent)]">
                    ✓
                  </span>
                  {b}
                </li>
              ))}
            </ul>
            <div className="mt-6 flex flex-wrap gap-3">
              <Link href={p.href} className={`btn ${p.isNew ? "btn-primary" : ""}`}>
                {p.cta}
              </Link>
              {p.more && (
                <Link href={p.more.href} className="btn">
                  {p.more.label}
                </Link>
              )}
            </div>
          </article>
        ))}
      </section>

      <section id="buyer-intent-how" className="mt-24 scroll-mt-24">
        <p className="text-center text-sm font-medium uppercase tracking-wider text-[var(--color-accent)]">Buyer Intent</p>
        <h2 className="mt-2 text-center text-3xl font-extrabold">How it works</h2>
        <div className="mt-10 grid gap-6 lg:grid-cols-3">
          {[
            ["1. Tell it what you sell", "Your product name, the phrases a buyer would use, the competitors they compare you with, and one sentence on what you do."],
            ["2. It sweeps on your schedule", "Daily, every 4 hours or hourly across the communities you pick. Sellers, job ads, tutorials and \"no vendors please\" posts are dropped."],
            ["3. You reply first", "Leads land ranked by buying intent in your inbox, Slack, Discord or webhook. Draft a reply with AI, edit it, post it yourself."],
          ].map(([t, b]) => (
            <div key={t} className="card p-6">
              <h3 className="font-bold">{t}</h3>
              <p className="mt-2 text-sm text-[var(--color-muted)]">{b}</p>
            </div>
          ))}
        </div>

        <div className="card mx-auto mt-8 max-w-3xl p-6">
          <div className="text-xs uppercase tracking-wider text-[var(--color-muted)]">Example sweep · names are placeholders</div>
          <ul className="mt-4 space-y-3">
            {EXAMPLE_LEADS.map((l) => (
              <li key={l.text} className="flex flex-wrap items-start gap-3 border-b border-[var(--color-border)] pb-3 last:border-0">
                <span className={TIER_BADGE[l.tier]} title={TIER_HINTS[l.tier]}>
                  {TIER_LABELS[l.tier]} · {l.score}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-xs text-[var(--color-muted)]">{l.source}</div>
                  <p className="text-sm">{l.text}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>

        <h3 className="mt-16 text-center text-2xl font-bold">Plugs into the tools you already use</h3>
        <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {INTEGRATIONS.map(([n, d]) => (
            <div key={n} className="card p-4">
              <div className="font-semibold">{n}</div>
              <div className="mt-1 text-sm text-[var(--color-muted)]">{d}</div>
            </div>
          ))}
        </div>

        <h3 className="mt-16 text-center text-2xl font-bold">Why not just search Reddit yourself?</h3>
        <div className="mt-6 overflow-x-auto">
          <table className="w-full min-w-[40rem] text-left text-sm">
            <thead>
              <tr className="text-[var(--color-muted)]">
                <th className="p-3"></th>
                <th className="p-3">Searching by hand</th>
                <th className="p-3">Keyword alerts</th>
                <th className="p-3 text-[var(--color-accent)]">CrawlProof Buyer Intent</th>
              </tr>
            </thead>
            <tbody>
              {COMPARE.map(([row, a, b, c]) => (
                <tr key={row} className="border-t border-[var(--color-border)]">
                  <th className="p-3 font-semibold">{row}</th>
                  <td className="p-3 text-[var(--color-muted)]">{a}</td>
                  <td className="p-3 text-[var(--color-muted)]">{b}</td>
                  <td className="p-3">{c}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="mx-auto mt-24 max-w-3xl">
        <h2 className="text-center text-3xl font-extrabold">Free trial questions</h2>
        <div className="mt-8 space-y-3">
          {FAQ.map(([q, a]) => (
            <details key={q} className="card p-5">
              <summary className="cursor-pointer font-semibold">{q}</summary>
              <p className="mt-3 text-sm text-[var(--color-muted)]">{a}</p>
            </details>
          ))}
        </div>
      </section>

      <section className="card mt-24 p-10 text-center">
        <h2 className="text-3xl font-extrabold">Your next customer just posted. Be the first to reply.</h2>
        <p className="mx-auto mt-3 max-w-xl text-[var(--color-muted)]">
          {TRIAL_DAYS} days of every paid feature and {TRIAL_CREDITS} trial credits. No card.
        </p>
        <Link href="/signup?redirect=/dashboard/intent" className="btn btn-primary mt-6">
          Start free
        </Link>
      </section>
    </main>
  );
}
