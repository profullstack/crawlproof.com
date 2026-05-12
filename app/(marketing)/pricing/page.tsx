import Link from "next/link";
import { CREDIT_PACKS, dollars } from "@/lib/credits";

export const metadata = { title: "Pricing" };

export default function PricingPage() {
  return (
    <main className="mx-auto max-w-6xl px-6 py-16">
      <h1 className="text-center text-4xl font-extrabold">Pay per scan</h1>
      <p className="mx-auto mt-2 max-w-2xl text-center text-[var(--color-muted)]">
        <strong>1 credit = 1 scan = $1.</strong> Pay with crypto via CoinPay.
        No subscription, no expiry. Scheduled scans (weekly) deduct 1 credit
        each time they run.
      </p>
      <div className="mx-auto mt-8 grid max-w-3xl gap-4 md:grid-cols-2">
        <div className="card p-5">
          <div className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
            Free scan
          </div>
          <h2 className="mt-1 text-lg font-bold">Rule-based AEO check</h2>
          <p className="mt-2 text-sm text-[var(--color-muted)]">
            Deterministic engine — fetches your site, parses HTML / JSON-LD /
            robots, generates a structured report. 3 free scans per IP per day.
          </p>
        </div>
        <div className="card p-5 ring-2 ring-[var(--color-accent)]">
          <div className="text-xs uppercase tracking-wider text-[var(--color-accent)]">
            Paid scan · 1 credit
          </div>
          <h2 className="mt-1 text-lg font-bold">Claude Opus 4.7 audit</h2>
          <p className="mt-2 text-sm text-[var(--color-muted)]">
            The same model used by ChatGPT-tier answer engines runs your audit
            with adaptive thinking + web research. Site-specific
            recommendations, deeper positioning analysis, prettier report.
          </p>
        </div>
      </div>

      <div className="mt-12 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {CREDIT_PACKS.map((p) => (
          <div
            key={p.id}
            className={`card p-6 ${p.popular ? "ring-2 ring-[var(--color-accent)]" : ""}`}
          >
            <div className="flex items-baseline justify-between">
              <h2 className="text-xl font-bold">{p.label}</h2>
              {p.popular && <span className="badge badge-pass">Popular</span>}
            </div>
            <div className="mt-3">
              <span className="text-3xl font-extrabold">{dollars(p.amountCents)}</span>
            </div>
            <div className="mt-1 text-sm text-[var(--color-muted)]">
              {p.credits} scan{p.credits === 1 ? "" : "s"}
            </div>
            <Link
              href="/settings/billing"
              className={`btn mt-6 w-full ${p.popular ? "btn-primary" : ""}`}
            >
              Buy
            </Link>
          </div>
        ))}
      </div>

      <p className="mt-8 text-center text-xs text-[var(--color-muted)]">
        Sign-ups include 3 free credits. Anonymous visitors get 3 free scans per day per IP.
      </p>
    </main>
  );
}
