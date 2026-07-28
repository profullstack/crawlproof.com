import Link from "next/link";
import { HeroAuditForm } from "@/components/hero-audit-form";

export const metadata = {
  title: "Slop Score — free carelessness scan for your site",
  description:
    "Free scan of up to 50 pages for observable defects: placeholder copy left in production, near-duplicate pages, leaked template variables, dead links, stale dates, missing alt text, and design drift. No signup, no LLM, no guesswork.",
  alternates: { canonical: "/slop" },
  openGraph: {
    title: "Slop Score — free carelessness scan",
    description:
      "Sweep up to 50 pages for the careless mistakes that ship to production. Free, no signup.",
    url: "/slop",
    type: "website",
  },
  // This block has to be declared even though it only restates the openGraph
  // one. Without it the page inherits the ROOT LAYOUT's twitter.images, which
  // outranks the generated ./opengraph-image.tsx — so X alone would fall back
  // to the generic /banner.png while every other platform showed the card.
  // Neither block declares `images`: the file convention supplies them.
  twitter: {
    card: "summary_large_image",
    title: "Slop Score — free carelessness scan",
    description:
      "Sweep up to 50 pages for the careless mistakes that ship to production. Free, no signup.",
  },
};

// The three dimensions, and their hints, mirror components/report/slop-meter.tsx
// so the landing page and the report describe the same thing in the same words.
const DIMENSIONS = [
  {
    label: "Content",
    hint: "Filler and placeholder copy, thin pages, near-duplicate pages, stale dates, claims with no evidence behind them.",
  },
  {
    label: "Code",
    hint: "Leaked template variables, preview-host URLs pointing at staging, dead links, broken or missing resources.",
  },
  {
    label: "Design",
    hint: "Missing viewport, missing alt text, layout-shift risks, palette and type sprawl across pages.",
  },
];

const EXAMPLES = [
  {
    finding: "“Coming soon” shipped to production",
    detail:
      "A standalone element still reading as a placeholder, months after launch — on a page that is linked from your nav.",
  },
  {
    finding: "Leaked template variable",
    detail:
      "A literal {{product_name}} or [insert company] rendered to visitors because a merge field never resolved.",
  },
  {
    finding: "Preview host in a live link",
    detail:
      "A production page linking to your-app.vercel.app — the staging copy, indexed and reachable.",
  },
  {
    finding: "Near-duplicate pages",
    detail:
      "Six location pages that differ only by the city name, splitting their own ranking signal.",
  },
];

export default function SlopPage() {
  return (
    <main>
      <section className="mx-auto max-w-4xl px-4 pb-12 pt-12 text-center sm:px-6 sm:pb-16 sm:pt-20">
        <p className="mb-3 text-sm font-medium uppercase tracking-wider text-[var(--color-accent)]">
          Free · No signup · Up to 50 pages
        </p>
        <h1 className="text-balance text-4xl font-extrabold leading-tight sm:text-5xl md:text-6xl">
          Find the careless mistakes on your site.
        </h1>
        <p className="mx-auto mt-5 max-w-2xl text-lg text-[var(--color-muted)]">
          The Slop Score sweeps up to 50 pages and reports what is{" "}
          <strong className="font-semibold text-[var(--color-fg)]">
            observably broken or sloppy
          </strong>{" "}
          — placeholder copy that shipped, template variables that never
          resolved, staging URLs in live links, duplicate pages, stale dates,
          missing alt text. One score, and a per-page list of what to fix.
        </p>
        <div className="mx-auto mt-8 max-w-xl">
          <HeroAuditForm defaultScan="slop" />
        </div>
        <p className="mx-auto mt-4 max-w-xl text-xs leading-relaxed text-[var(--color-muted)]">
          Runs no AI model, so there is nothing to queue behind and nothing to
          pay for. The report opens on-page in seconds and is yours to share.
        </p>
      </section>

      <section className="mx-auto max-w-5xl px-4 pb-16 sm:px-6">
        <h2 className="mb-2 text-center text-2xl font-bold">How the score reads</h2>
        <p className="mx-auto mb-8 max-w-2xl text-center text-sm text-[var(--color-muted)]">
          The dial runs the opposite way to a grade: <strong>0 is pristine</strong>,
          100 is maximum slop. Lower is better.
        </p>
        <div className="card p-4 sm:p-6">
          <div
            className="h-3 w-full overflow-hidden rounded-full"
            style={{
              background:
                "linear-gradient(to right, var(--color-pass) 0%, var(--color-pass) 25%, var(--color-warn) 25%, var(--color-warn) 50%, var(--color-fail) 50%, var(--color-fail) 100%)",
            }}
            role="img"
            aria-label="Score bands: 0 to 25 clean, 26 to 50 careless, 51 to 100 sloppy"
          />
          <div className="mt-3 grid gap-3 text-sm sm:grid-cols-3">
            <div>
              <p className="font-semibold" style={{ color: "var(--color-pass)" }}>
                0–25 · Clean
              </p>
              <p className="text-[var(--color-muted)]">
                Nothing obviously careless. Fix the stragglers and move on.
              </p>
            </div>
            <div>
              <p className="font-semibold" style={{ color: "var(--color-warn)" }}>
                26–50 · Careless
              </p>
              <p className="text-[var(--color-muted)]">
                Real defects a visitor can hit. Usually a handful of pages doing
                most of the damage.
              </p>
            </div>
            <div>
              <p className="font-semibold" style={{ color: "var(--color-fail)" }}>
                51–100 · Sloppy
              </p>
              <p className="text-[var(--color-muted)]">
                Systemic — the same mistake repeated across templates rather
                than one bad page.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-5xl px-4 pb-16 sm:px-6">
        <h2 className="mb-8 text-center text-2xl font-bold">What gets swept</h2>
        <div className="grid gap-4 sm:grid-cols-3">
          {DIMENSIONS.map((d) => (
            <div key={d.label} className="card p-4">
              <p className="text-sm font-semibold">{d.label}</p>
              <p className="mt-1.5 text-sm leading-relaxed text-[var(--color-muted)]">{d.hint}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="mx-auto max-w-5xl px-4 pb-16 sm:px-6">
        <h2 className="mb-2 text-center text-2xl font-bold">The kind of thing it catches</h2>
        <p className="mx-auto mb-8 max-w-2xl text-center text-sm text-[var(--color-muted)]">
          Every finding points at a specific page and a specific line of
          evidence — never a vibe.
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          {EXAMPLES.map((e) => (
            <div key={e.finding} className="card p-4">
              <p className="text-sm font-semibold">{e.finding}</p>
              <p className="mt-1.5 text-sm leading-relaxed text-[var(--color-muted)]">{e.detail}</p>
            </div>
          ))}
        </div>
      </section>

      {/* The positioning guardrail, stated as a feature. This is deliberate and
          load-bearing: an "is this AI-written?" score is unfalsifiable, misfires
          on non-native English writers, and would accuse paying customers.
          tests/slop.test.ts guards the engine against drifting into it. */}
      <section className="mx-auto max-w-3xl px-4 pb-20 sm:px-6">
        <div className="card p-5 sm:p-6">
          <h2 className="text-xl font-bold">What this is not</h2>
          <p className="mt-3 text-sm leading-relaxed text-[var(--color-muted)]">
            This is <strong className="text-[var(--color-fg)]">not an AI-detector</strong>. We
            never estimate whether a human or a model wrote your page, and we
            never report a probability that it did. Those classifiers cannot be
            checked against the truth, and they misfire hardest on people
            writing in a second language.
          </p>
          <p className="mt-3 text-sm leading-relaxed text-[var(--color-muted)]">
            Every Slop Score finding is an{" "}
            <strong className="text-[var(--color-fg)]">observable defect</strong> — something you
            can open the page and see for yourself. If you disagree with one,
            you can prove us wrong, which is the whole point.
          </p>
        </div>
      </section>

      <section className="mx-auto max-w-3xl px-4 pb-20 text-center sm:px-6">
        <h2 className="text-2xl font-bold">Want the AI-crawler view too?</h2>
        <p className="mx-auto mt-3 max-w-xl text-sm text-[var(--color-muted)]">
          The Slop Score covers carelessness. The free AEO audit covers what
          ChatGPT, Claude, Perplexity, and Google AI Overviews can actually find
          on your site — schema, robots rules, AI-bot access, and positioning.
        </p>
        <Link href="/" className="btn btn-primary mt-6 inline-block">
          Run a free AEO audit
        </Link>
      </section>
    </main>
  );
}
