import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { HOLD_DAYS, PAYOUT_MIN_CENTS, PAYS, WINDOW_DAYS, termsLine } from "@/lib/affiliate/program";

export const metadata = {
  title: "Affiliate program — no network, no application, paid in USDC",
  description:
    "Send people to CrawlProof and earn a share of what they buy. The terms are a public file, joining is a profile, the link is one parameter, and the money goes from us to your wallet with nobody in between.",
  alternates: { canonical: "/affiliate" },
  openGraph: {
    title: "CrawlProof affiliate program",
    description: "Public terms, no application, one link parameter, paid in USDC on Polygon. An OpenAffiliate program.",
    url: "/affiliate",
  },
};

/**
 * The public page for the program. Every figure comes from lib/affiliate/program
 * so the pitch cannot drift from what the descriptor and the ledger pay.
 */
export default async function AffiliateMarketingPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (user) redirect("/dashboard/affiliate");

  const sale = PAYS.find((p) => p.event === "sale");
  const rate = sale?.kind === "percent" ? `${sale.value}%` : sale ? `$${sale.value}` : "a share";

  return (
    <main className="mx-auto max-w-5xl px-4 py-16 sm:px-6">
      <section className="text-center">
        <p className="mb-3 text-sm font-medium uppercase tracking-wider text-[var(--color-accent)]">CrawlProof partners</p>
        <h1 className="text-4xl font-extrabold sm:text-5xl">Earn {rate} of what you send us. No network in the way.</h1>
        <p className="mx-auto mt-4 max-w-2xl text-lg text-[var(--color-muted)]">{termsLine()}</p>
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <Link href="/signup" className="btn btn-primary">
            Get your link
          </Link>
          <Link href="/affiliate/programs" className="btn">
            Programs you can join
          </Link>
        </div>
      </section>

      <section className="mt-16 grid gap-6 sm:grid-cols-3">
        <div className="card p-5">
          <h2 className="text-lg font-semibold">The terms are a file</h2>
          <p className="mt-2 text-sm text-[var(--color-muted)]">
            Everything on this page is also at <code className="font-mono text-xs">/.well-known/openaffiliate.json</code>, in a shape any script or agent can read. What the file says is what the ledger pays, and the terms only ever change forward.
          </p>
        </div>
        <div className="card p-5">
          <h2 className="text-lg font-semibold">No application</h2>
          <p className="mt-2 text-sm text-[var(--color-muted)]">
            Sign in and your link exists. Outside CrawlProof, POST an OpenProfile.md URL to the join endpoint and get a link and a ledger token back at once.
          </p>
        </div>
        <div className="card p-5">
          <h2 className="text-lg font-semibold">Nobody in the money</h2>
          <p className="mt-2 text-sm text-[var(--color-muted)]">
            A conversion waits out the {HOLD_DAYS}-day refund window, then it is approved, then it is sent to your wallet in USDC on Polygon from ${(PAYOUT_MIN_CENTS / 100).toFixed(0)}. No network fee, because there is no network.
          </p>
        </div>
      </section>

      <section className="mt-16">
        <h2 className="text-2xl font-bold">How a click becomes money</h2>
        <ol className="mt-4 list-decimal space-y-2 pl-6 text-[var(--color-muted)]">
          <li>
            Add <code className="font-mono">?oa=yourcode</code> to any CrawlProof page. The visitor lands on that page; the parameter is stripped and a {WINDOW_DAYS}-day window starts.
          </li>
          <li>They sign in and buy credits inside the window. The purchase is recorded to you, pending, with the day it will be approved.</li>
          <li>After {HOLD_DAYS} days with no refund it is approved. A reversal always says why.</li>
          <li>Weekly, the approved balance goes to your wallet. Or press pay out now.</li>
        </ol>
        <p className="mt-4 text-sm text-[var(--color-muted)]">
          Only a real page visit sets the window. A parameter on an image, a frame or a script sets nothing, and your own purchases do not pay you.
        </p>
      </section>

      <section className="mt-16">
        <h2 className="text-2xl font-bold">Join other programs from the same place</h2>
        <p className="mt-2 text-[var(--color-muted)]">
          Any merchant that serves an OpenAffiliate file can be joined from your dashboard with one profile, and every ledger shows on one page. That is the point of the spec: one shape, so an affiliate does not need ten dashboards, and a merchant does not need a network.
        </p>
        <p className="mt-2 text-sm text-[var(--color-muted)]">
          Read the spec at{" "}
          <a className="underline" href="https://logicsrc.com/openaffiliate">
            logicsrc.com/openaffiliate
          </a>
          . Full terms at <Link className="underline" href="/affiliate/terms">/affiliate/terms</Link>.
        </p>
      </section>
    </main>
  );
}
