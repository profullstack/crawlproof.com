import Link from "next/link";

export const metadata = { title: "Pricing" };

const tiers = [
  {
    name: "Free",
    price: "$0",
    cadence: "forever",
    features: [
      "10 audits per month",
      "30-day history",
      "Public reports by default",
      "All 10 audit sections",
    ],
    cta: { label: "Start free", href: "/signup" },
    highlight: false,
  },
  {
    name: "Pro",
    price: "$29",
    cadence: "per month",
    features: [
      "Unlimited audits",
      "Scheduled weekly re-runs",
      "Diff view between runs",
      "PDF export",
      "Private reports",
      "Email support",
    ],
    cta: { label: "Upgrade", href: "/settings/billing" },
    highlight: true,
  },
  {
    name: "Team",
    price: "$99",
    cadence: "per month",
    features: [
      "5 seats",
      "Shared projects",
      "Slack notifications",
      "Priority email support",
    ],
    cta: { label: "Contact us", href: "mailto:sales@crawlproof.com" },
    highlight: false,
    badge: "Coming soon",
  },
];

export default function PricingPage() {
  return (
    <main className="mx-auto max-w-6xl px-6 py-16">
      <h1 className="text-center text-4xl font-extrabold">Simple pricing</h1>
      <p className="mt-2 text-center text-[var(--color-muted)]">
        Start free. Upgrade when scheduled re-audits and diffs become useful.
      </p>
      <div className="mt-12 grid gap-4 md:grid-cols-3">
        {tiers.map((t) => (
          <div
            key={t.name}
            className={`card p-6 ${t.highlight ? "ring-2 ring-[var(--color-accent)]" : ""}`}
          >
            <div className="flex items-baseline justify-between">
              <h2 className="text-xl font-bold">{t.name}</h2>
              {t.badge && <span className="badge">{t.badge}</span>}
            </div>
            <div className="mt-3">
              <span className="text-3xl font-extrabold">{t.price}</span>{" "}
              <span className="text-sm text-[var(--color-muted)]">{t.cadence}</span>
            </div>
            <ul className="mt-4 space-y-2 text-sm">
              {t.features.map((f) => (
                <li key={f} className="text-[var(--color-fg)]">
                  <span className="mr-2 text-[var(--color-accent)]">✓</span>
                  {f}
                </li>
              ))}
            </ul>
            <Link
              href={t.cta.href}
              className={`btn mt-6 w-full ${t.highlight ? "btn-primary" : ""}`}
            >
              {t.cta.label}
            </Link>
          </div>
        ))}
      </div>
    </main>
  );
}
