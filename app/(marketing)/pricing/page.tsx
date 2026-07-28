import Link from "next/link";
import {
  CREDIT_PACKS,
  CREDIT_RACK_CENTS,
  ENGINES,
  LEAD_RUN_CREDITS,
  OUTREACH_CREDITS,
  SCAN_CREDITS,
  discountPct,
  dollars,
  perCreditCents,
} from "@/lib/credits";

export const metadata = {
  title: "Pricing",
  description:
    "Rule-based AEO scans are free up to the daily limit. AI-model scans cost 20 credits (~$1) each, with volume discounts up to 50% off.",
  alternates: { canonical: "/pricing" },
  openGraph: {
    title: "Pricing · CrawlProof",
    description:
      "Rule-based scans are free up to the daily limit. AI-model scans cost 20 credits (~$1) each, volume discounts to 50%.",
    url: "/pricing",
  },
};

export default function PricingPage() {
  return (
    <main className="mx-auto max-w-6xl px-4 sm:px-6 py-16">
      <h1 className="text-center text-4xl font-extrabold">Pay per scan</h1>
      <p className="mx-auto mt-2 max-w-2xl text-center text-[var(--color-muted)]">
        Rule-based scans are free up to the daily limit. AI-model scans cost{" "}
        <strong>20 credits (~$1) each</strong>. Buy credits with crypto via CoinPay;
        no subscription, no expiry.
      </p>
      <div className="mx-auto mt-8 grid max-w-6xl gap-4 md:grid-cols-2 lg:grid-cols-3">
        {(Object.keys(ENGINES) as Array<keyof typeof ENGINES>).map((k) => {
          const m = ENGINES[k];
          const tag =
            m.cost === 0
              ? "Free scan · 0 credits"
              : `Paid scan · ${m.cost} credit${m.cost === 1 ? "" : "s"}`;
          const accent = m.popular;
          return (
            <div
              key={k}
              className={`card p-5 ${accent ? "ring-2 ring-[var(--color-accent)]" : ""} ${m.available ? "" : "opacity-60"}`}
            >
              <div
                className={`text-xs uppercase tracking-wider ${accent ? "text-[var(--color-accent)]" : "text-[var(--color-muted)]"}`}
              >
                {tag}
              </div>
              <h2 className="mt-1 text-lg font-bold">{m.label}</h2>
              <p className="mt-2 text-sm text-[var(--color-muted)]">{m.blurb}</p>
              {!m.available && (
                <span className="badge badge-warn mt-3 inline-block">Coming soon</span>
              )}
            </div>
          );
        })}
      </div>

      {/* Credits buy more than scans, and a page that only prices scans makes
          every other module look like it is either free or unavailable. */}
      <section className="mt-14">
        <h2 className="text-center text-2xl font-bold">What else credits buy</h2>
        <p className="mx-auto mt-2 max-w-2xl text-center text-sm text-[var(--color-muted)]">
          One balance across the whole platform. No module has its own plan.
        </p>
        <div className="mx-auto mt-6 grid max-w-4xl gap-4 sm:grid-cols-3">
          <div className="card p-5">
            <div className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
              {LEAD_RUN_CREDITS} credits
            </div>
            <h3 className="mt-1 font-bold">Lead generation run</h3>
            <p className="mt-2 text-sm text-[var(--color-muted)]">
              One pass of a campaign: discovery, contact lookup, drafting and sending. A run with
              nothing to do is not charged.{" "}
              <Link href="/lead-generation" className="underline">
                How it works
              </Link>
            </p>
          </div>
          <div className="card p-5">
            <div className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
              {OUTREACH_CREDITS} credit
            </div>
            <h3 className="mt-1 font-bold">Outreach send</h3>
            <p className="mt-2 text-sm text-[var(--color-muted)]">
              One email, SMS recipient or social post sent by hand, outside a campaign run.
            </p>
          </div>
          <div className="card p-5">
            <div className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
              {SCAN_CREDITS} credits
            </div>
            <h3 className="mt-1 font-bold">Autoblog post</h3>
            <p className="mt-2 text-sm text-[var(--color-muted)]">
              A researched, illustrated, published long-form article — the same price as an
              AI-model scan.
            </p>
          </div>
        </div>
      </section>

      <div className="mt-12 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {CREDIT_PACKS.map((p) => {
          const off = discountPct(p);
          return (
            <div
              key={p.id}
              className={`card p-6 ${p.popular ? "ring-2 ring-[var(--color-accent)]" : ""}`}
            >
              <div className="flex items-baseline justify-between">
                <h2 className="text-xl font-bold">{p.label}</h2>
                {p.popular ? (
                  <span className="badge badge-pass">Popular</span>
                ) : off > 0 ? (
                  <span className="badge badge-warn">{off}% off</span>
                ) : null}
              </div>
              <div className="mt-3 flex items-baseline gap-2">
                <span className="text-3xl font-extrabold">{dollars(p.amountCents)}</span>
                {off > 0 && (
                  <span className="text-sm text-[var(--color-muted)] line-through">
                    {dollars(p.credits * CREDIT_RACK_CENTS)}
                  </span>
                )}
              </div>
              <div className="mt-1 text-sm text-[var(--color-muted)]">
                {p.credits} credit{p.credits === 1 ? "" : "s"} ·{" "}
                <span className="font-mono text-xs">
                  {dollars(perCreditCents(p))}/credit
                </span>
              </div>
              <Link
                href="/settings/billing"
                className={`btn mt-6 w-full ${p.popular ? "btn-primary" : ""}`}
              >
                Buy
              </Link>
            </div>
          );
        })}
      </div>

      <p className="mt-8 text-center text-xs text-[var(--color-muted)]">
        Sign-ups include 20 free credits (1 AI-model scan). Anonymous visitors get 10
        free rule-based scans per day per IP.
      </p>
    </main>
  );
}
