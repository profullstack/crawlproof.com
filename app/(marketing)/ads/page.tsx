import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  CPC_CREDITS,
  CPC_CENTS,
  MIN_PAYOUT_CENTS,
  MAX_DEPOSIT_MATCH_CENTS,
  creditsToPayoutCents,
  centsToDollars,
} from "@/lib/ads/pricing";
import {
  AD_FORMATS,
  PUBLISHER_FORMAT_IDS,
  TERMINAL_FORMAT_ID,
  TERMINAL_COLS_LABEL,
  formatSpec,
} from "@/lib/ads/formats";

export const metadata = {
  title: "Ads — advertise on the network, or get paid to run it",
  description:
    "Paste a landing-page URL and the creative is designed for you. Or drop one tag on your site and earn crypto for the clicks. Flat cost-per-click, a daily budget you set, and no minimum spend.",
  alternates: { canonical: "/ads" },
  openGraph: {
    title: "CrawlProof Ads",
    description:
      "Advertise on the CrawlProof network, or monetize your own site and get paid in crypto for the clicks.",
    url: "/ads",
  },
};

/**
 * The public sales page for the ad network. Two audiences share it, because the
 * network is two-sided and the same person is often both: advertisers fund it,
 * publishers carry it.
 *
 * Every figure is imported from lib/ads/pricing rather than typed in, so the
 * page cannot quote a rate the biller has since moved off. The one number worth
 * being careful about is the publisher's: it is derived from
 * creditsToPayoutCents, the same function ad_charge_click() mirrors, so what a
 * publisher reads here is what actually accrues.
 */

export default async function AdsMarketingPage() {
  // Signed-in visitors want their campaigns, not the pitch. The dashboard is
  // the only place the two halves of the product are actionable.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (user) redirect("/dashboard/ads");

  const perClickPayout = creditsToPayoutCents(CPC_CREDITS);
  const publisherFormats = PUBLISHER_FORMAT_IDS.map((id) => formatSpec(id));
  const terminal = AD_FORMATS.find((f) => f.id === TERMINAL_FORMAT_ID);

  return (
    <main className="mx-auto max-w-5xl px-4 py-16 sm:px-6">
      <section className="text-center">
        <p className="mb-3 text-sm font-medium uppercase tracking-wider text-[var(--color-accent)]">
          CrawlProof Ads
        </p>
        <h1 className="text-4xl font-extrabold sm:text-5xl">
          Advertise on the network. Or get paid to run it.
        </h1>
        <p className="mx-auto mt-4 max-w-2xl text-lg text-[var(--color-muted)]">
          Give us a landing-page URL and the ads get designed for you. Set a daily budget and
          pay {centsToDollars(CPC_CENTS)} a click, nothing for the impressions. On the other
          side of it, put one tag on your own site and earn crypto every time somebody clicks.
        </p>
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <Link href="/signup" className="btn btn-primary">
            Create an ad
          </Link>
          <Link href="/signup" className="btn">
            Monetize a site
          </Link>
        </div>
        <p className="mt-4 text-sm text-[var(--color-muted)]">
          No minimum spend, no monthly fee, no sales call. Your first deposit is matched in
          bonus ad credits, up to {centsToDollars(MAX_DEPOSIT_MATCH_CENTS)}.
        </p>
      </section>

      {/* ── Advertisers ─────────────────────────────────────────────── */}

      <section className="mt-20">
        <h2 className="text-2xl font-bold">For advertisers</h2>
        <p className="mt-2 max-w-3xl text-[var(--color-muted)]">
          The reason small advertisers give up on display is not the money, it is the two
          afternoons in a design tool before a single impression is served. So that part is
          done for you.
        </p>
        <div className="mt-6 grid gap-4 sm:grid-cols-3">
          <Card
            title="A URL is the whole brief"
            body="Your landing page is read for its brand — colours, logo, the words you already use — and a full set of on-brand creatives comes back. Edit the copy, swap the palette, upload your own logo, or ship what you got."
          />
          <Card
            title="Every size at once"
            body={`${AD_FORMATS.length} formats from one campaign: the standard display sizes, a borderless text link that reads as part of the page, and an ASCII unit for terminals.`}
          />
          <Card
            title="A budget that actually stops"
            body="You set a daily cap. Delivery stops when the day's spend reaches it and picks up again tomorrow. There is no overage line and no way to spend a month's budget by lunchtime."
          />
        </div>

        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          <Card
            title="You are not bidding against a wall"
            body="Placement is a bid-weighted lottery, not winner-takes-all. A higher bid wins more often, but it never corners the inventory — every live campaign keeps serving, so a modest budget still gets delivery instead of silence."
          />
          <Card
            title="Clicks, counted conservatively"
            body="Bot traffic is not billed, and the same visitor clicking your campaign again inside six hours is not billed twice. When a click looks doubtful the visitor still gets through to your site; you just are not charged for it."
          />
        </div>
      </section>

      <section className="mt-12 rounded-xl border border-[var(--color-border)] bg-[var(--color-card)] p-8">
        <h2 className="text-2xl font-bold">What a click costs</h2>
        <div className="mt-6 grid gap-6 sm:grid-cols-2">
          <div>
            <div className="text-3xl font-extrabold">
              {centsToDollars(CPC_CENTS)}
              <span className="ml-2 text-base font-normal text-[var(--color-muted)]">
                per click ({CPC_CREDITS} credits)
              </span>
            </div>
            <p className="mt-3 text-sm text-[var(--color-muted)]">
              Flat cost-per-click at the rack rate, and impressions are free. Credits are the
              same ones scans, articles and lead runs spend, so there is no separate ad wallet
              to top up and nothing expires.
            </p>
          </div>
          <div>
            <div className="text-3xl font-extrabold">
              100%
              <span className="ml-2 text-base font-normal text-[var(--color-muted)]">
                first-deposit match
              </span>
            </div>
            <p className="mt-3 text-sm text-[var(--color-muted)]">
              Your first deposit is matched credit for credit in bonus ad credits, up to{" "}
              {centsToDollars(MAX_DEPOSIT_MATCH_CENTS)} of value. Buying a volume pack brings
              the real cost of a click down well below the rack rate.
            </p>
          </div>
        </div>
        <div className="mt-6 flex flex-wrap gap-3">
          <Link href="/signup" className="btn btn-primary">
            Start a campaign
          </Link>
          <Link href="/pricing" className="btn">
            Credit packs
          </Link>
        </div>
      </section>

      {/* ── Publishers ──────────────────────────────────────────────── */}

      <section className="mt-20">
        <h2 className="text-2xl font-bold">For publishers</h2>
        <p className="mt-2 max-w-3xl text-[var(--color-muted)]">
          The usual ad network wants a traffic threshold, a tax form and six weeks of review
          before it will talk to you. This one wants a site and a wallet address.
        </p>
        <div className="mt-6 grid gap-4 sm:grid-cols-3">
          <Card
            title="One tag"
            body="Add your site, copy the snippet, paste it where the ad should go. If the site is a repo you have connected, the tag can be installed for you as a pull request."
          />
          <Card
            title="Paid in crypto"
            body={`Earnings accrue per click and withdraw to a wallet you choose — USDC, USDT, BTC, ETH or SOL among others. Minimum withdrawal is ${centsToDollars(MIN_PAYOUT_CENTS)}, and every payout carries its transaction hash.`}
          />
          <Card
            title="No traffic minimum"
            body="A hobby project earns less than a busy one. It does not earn nothing, and it does not get turned away at signup for being small."
          />
        </div>

        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          <div className="card p-5">
            <h3 className="font-semibold">What a click pays</h3>
            <div className="mt-2 text-3xl font-extrabold">
              {centsToDollars(perClickPayout)}
              <span className="ml-2 text-base font-normal text-[var(--color-muted)]">
                per click, at the default bid
              </span>
            </div>
            <p className="mt-3 text-sm text-[var(--color-muted)]">
              Advertisers can bid above the default, and a higher-bidding campaign winning your
              slot pays you proportionally more. Impressions earn nothing on their own, which is
              the honest version: you are paid when the ad worked.
            </p>
          </div>
          <div className="card p-5">
            <h3 className="font-semibold">Counted on our side, not yours</h3>
            <p className="mt-3 text-sm text-[var(--color-muted)]">
              Impressions and clicks are metered server-side, so the number in your dashboard is
              the number that gets paid. Repeat loads of the same slot inside a short window
              collapse into one impression rather than inflating a figure nobody can bank.
            </p>
          </div>
        </div>
      </section>

      <section className="mt-12">
        <h3 className="text-lg font-semibold">Formats you can run</h3>
        <div className="mt-4 flex flex-wrap gap-2">
          {publisherFormats.map((f) => (
            <span
              key={f.id}
              className="rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] px-3 py-2 text-sm"
            >
              {f.label}{" "}
              <span className="font-mono text-xs text-[var(--color-muted)]">
                {f.w}×{f.h}
              </span>
            </span>
          ))}
          {terminal && (
            <span className="rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] px-3 py-2 text-sm">
              {terminal.label}{" "}
              <span className="font-mono text-xs text-[var(--color-muted)]">
                {TERMINAL_COLS_LABEL}
              </span>
            </span>
          )}
        </div>
        <p className="mt-4 max-w-3xl text-sm text-[var(--color-muted)]">
          The terminal unit is the odd one out and the point of it is that nobody else sells it:
          a plain-text ASCII box you can <span className="font-mono">curl</span>{" "}
          into an SSH login banner, a shell MOTD, a BBS screen or a CLI tool&apos;s output. It is fetched
          over HTTP rather than embedded, so it works in places a browser never reaches.
        </p>
      </section>

      {/* ── Both sides ──────────────────────────────────────────────── */}

      <section className="mt-20 rounded-xl border border-[var(--color-border)] bg-[var(--color-card)] p-8">
        <h2 className="text-2xl font-bold">Run both sides</h2>
        <p className="mt-2 max-w-3xl text-[var(--color-muted)]">
          Most people here are both: they have something to promote and a site that could be
          carrying ads for somebody else. Both live under the same account and the same credit
          balance, so what you earn as a publisher can fund what you spend as an advertiser
          without a payout ever leaving the system.
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <Link href="/signup" className="btn btn-primary">
            Get started free
          </Link>
          <Link href="/login" className="btn">
            Sign in
          </Link>
        </div>
      </section>

      <p className="mt-10 text-center text-xs text-[var(--color-muted)]">
        Advertisers are responsible for what they promote, and publishers for what they run.
        Campaigns are reviewed and either side can be removed from the network for abuse.
      </p>
    </main>
  );
}

function Card({ title, body }: { title: string; body: string }) {
  return (
    <div className="card p-5">
      <h3 className="font-semibold">{title}</h3>
      <p className="mt-2 text-sm text-[var(--color-muted)]">{body}</p>
    </div>
  );
}
