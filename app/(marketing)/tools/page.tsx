import Link from "next/link";
import { ANON_DAILY_SCANS, ENGINES, SIGNUP_CREDITS, type Engine } from "@/lib/credits";

// Every free scanner, in one place.
//
// Six of the engines cost nothing, but only two of them — the rule-based AEO
// audit and the Slop Score — can run without an account, and those two are the
// only ones the homepage selector offers. So the other four were real, free,
// and undiscoverable: /pricing listed them among the paid engines, and nothing
// linked anywhere.
//
// The split is stated rather than hidden. Putting all six in the anonymous
// selector would be the obvious "fix" and the wrong one — four of them would
// fail on submit, because `ANON_ENGINES` in app/actions/runAudit.ts genuinely
// only permits two. Telling somebody a tool needs an account is a better
// experience than letting them find out by having it not work.

export const metadata = {
  title: "Free website scanners",
  description:
    "Every free CrawlProof scanner: AEO audit, Slop Score, DNS analyzer, link checker, specification.website checklist and the Vu1nz security scan.",
  alternates: { canonical: "/tools" },
};

/** Runs without an account — kept in sync with ANON_ENGINES in app/actions/runAudit.ts. */
const ANONYMOUS: Engine[] = ["rule", "slop"];

/** Where each free engine can be started, when it has its own entry point. */
const START_AT: Partial<Record<Engine, string>> = {
  rule: "/",
  slop: "/slop",
};

export default function ToolsPage() {
  const free = (Object.keys(ENGINES) as Engine[]).filter(
    (k) => ENGINES[k].cost === 0 && ENGINES[k].available,
  );
  const anonymous = free.filter((k) => ANONYMOUS.includes(k));
  const needsAccount = free.filter((k) => !ANONYMOUS.includes(k));

  return (
    <main className="mx-auto max-w-5xl px-4 sm:px-6 py-16">
      <h1 className="text-center text-4xl font-extrabold">Free website scanners</h1>
      <p className="mx-auto mt-3 max-w-2xl text-center text-[var(--color-muted)]">
        {free.length} scanners that cost nothing to run. {anonymous.length} need no
        account at all — anonymous visitors get {ANON_DAILY_SCANS} scans per day per
        IP. The rest are free once you sign up, which also includes{" "}
        {SIGNUP_CREDITS} credits for the AI-model audits.
      </p>

      <section className="mt-12">
        <h2 className="text-2xl font-bold">No account needed</h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          {anonymous.map((k) => (
            <ToolCard key={k} engine={k} href={START_AT[k]} cta="Run it free" />
          ))}
        </div>
      </section>

      <section className="mt-12">
        <h2 className="text-2xl font-bold">Free with an account</h2>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          Still zero credits to run — signing in is what makes them available.
        </p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          {needsAccount.map((k) => (
            <ToolCard key={k} engine={k} href="/signup" cta="Sign up free" />
          ))}
        </div>
      </section>

      <p className="mt-12 text-center text-sm text-[var(--color-muted)]">
        Looking for the AI-model audits?{" "}
        <Link href="/pricing" className="underline">
          See pricing
        </Link>
        .
      </p>
    </main>
  );
}

function ToolCard({
  engine,
  href,
  cta,
}: {
  engine: Engine;
  href?: string;
  cta: string;
}) {
  const meta = ENGINES[engine];
  return (
    <div className="card flex flex-col p-5">
      <div className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
        Free · 0 credits
      </div>
      <h3 className="mt-1 text-lg font-bold">{meta.label}</h3>
      <p className="mt-2 flex-1 text-sm text-[var(--color-muted)]">{meta.blurb}</p>
      {href && (
        <Link href={href} className="btn mt-4 w-full">
          {cta}
        </Link>
      )}
    </div>
  );
}
