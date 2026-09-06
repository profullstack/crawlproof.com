import Link from "next/link";

export const metadata = {
  title: "CLI",
  description:
    "Install the CrawlProof CLI and read your traffic, ad delivery and spend from a terminal. Live dashboard, plain-text stats, and one-command ad campaigns.",
  alternates: { canonical: "/docs/cli" },
};

/** A command and what it is for, so the page reads as a reference rather than prose. */
function Cmd({ children, note }: { children: string; note?: string }) {
  return (
    <div className="mt-3">
      <pre className="overflow-x-auto rounded border border-[var(--color-border)] bg-[#0b0d10] p-3 font-mono text-xs leading-relaxed">
        {children}
      </pre>
      {note ? <p className="mt-1 text-xs text-[var(--color-muted)]">{note}</p> : null}
    </div>
  );
}

export default function CliDocsPage() {
  return (
    <main className="mx-auto max-w-3xl px-4 py-16 sm:px-6">
      <p className="text-sm">
        <Link href="/docs" className="text-[var(--color-muted)] hover:underline">
          ← Docs
        </Link>
      </p>
      <h1 className="mt-2 text-4xl font-extrabold">CLI</h1>
      <p className="mt-3 text-[var(--color-muted)]">
        <code className="font-mono">crawlproof</code> reads your account from a
        terminal: who arrived on every site you own, what your ads delivered,
        and — when a CoinPay merchant session is on the machine — what the bank
        actually did. It is the same data the dashboard renders, without a
        browser.
      </p>

      <section className="mt-10 space-y-3">
        <h2 className="text-2xl font-bold">Install</h2>
        <Cmd note="Needs Node 22.6 or newer for the dashboard. stats and --json run anywhere.">
          npm install -g @profullstack/crawlproof
        </Cmd>
        <p className="text-sm leading-relaxed">
          Authenticate with an API token from{" "}
          <strong>Social → API tokens</strong>. Either export it, or drop it in{" "}
          <code className="font-mono">~/.crawlproof.json</code> so you never
          have to think about it again.
        </p>
        <Cmd>{`export CRAWLPROOF_TOKEN=crp_…

# or, once:
echo '{ "token": "crp_…" }' > ~/.crawlproof.json && chmod 600 ~/.crawlproof.json`}</Cmd>
      </section>

      <section className="mt-10 space-y-3">
        <h2 className="text-2xl font-bold">The dashboard</h2>
        <p className="text-sm leading-relaxed">
          Five live screens: <strong>ROI</strong>, <strong>Traffic</strong>,{" "}
          <strong>Ads</strong>, <strong>Money</strong> and{" "}
          <strong>Spend</strong>. It refreshes on a timer.
        </p>
        <Cmd note="1-5 or Tab switches screens · w cycles the window · b cycles humans / all / bots · r refreshes · ? explains the arithmetic · q quits.">
          {`crawlproof dashboard
crawlproof dashboard --range=1m --who=all
crawlproof dashboard --sites=example.com,blog.example.com`}
        </Cmd>
        <p className="text-sm leading-relaxed">
          Aliases: <code className="font-mono">roi</code> and{" "}
          <code className="font-mono">tui</code>. On a machine with no terminal,{" "}
          <code className="font-mono">--json</code> prints the same snapshot the
          screens render.
        </p>
        <Cmd>{`crawlproof dashboard --json | jq .roi.derived
crawlproof dashboard --json | jq '.sites[] | {site, visitors}'`}</Cmd>
      </section>

      <section className="mt-10 space-y-3">
        <h2 className="text-2xl font-bold">Traffic, as text</h2>
        <p className="text-sm leading-relaxed">
          Sources, referrers and top pages for one site. Defaults to the last
          day and humans only, because a launch is invisible inside a month of
          crawler traffic. With a single project the site can be left out.
        </p>
        <Cmd>{`crawlproof stats
crawlproof stats example.com --range=1w
crawlproof stats example.com --who=bots --json`}</Cmd>
        <pre className="overflow-x-auto rounded border border-[var(--color-border)] bg-[#0b0d10] p-3 font-mono text-xs leading-relaxed">{`example.com  1d  humans
172 visitors, 58 pageviews

Sources
  Referral · example.com     163
  Search · google              9

Pages
  /                           18
  /pricing                     7`}</pre>
      </section>

      <section className="mt-10 space-y-3">
        <h2 className="text-2xl font-bold">Run an ad</h2>
        <p className="text-sm leading-relaxed">
          CrawlProof reads the page, writes the creatives and starts serving. A
          URL that already has a live campaign gets that campaign back rather
          than a duplicate, so running it twice is safe.
        </p>
        <Cmd note="A ref looks like crawlproof-ad-144.">
          {`crawlproof ad https://example.com/launch
crawlproof ad https://example.com/launch --budget=500 --name "Launch"

crawlproof ads
crawlproof ads show crawlproof-ad-144
crawlproof ads pause crawlproof-ad-144
crawlproof ads budget crawlproof-ad-144 250`}
        </Cmd>
      </section>

      <section className="mt-10 space-y-3">
        <h2 className="text-2xl font-bold">What the numbers mean</h2>
        <p className="text-sm leading-relaxed">
          Two rules run through the ROI arithmetic, and both exist because
          breaking either produces a friendlier number that is false.
        </p>
        <p className="text-sm leading-relaxed">
          <strong>Self-deal is not revenue.</strong> Where an account advertises
          on its own slots, ad spend and ad earnings are one dollar moving
          between two pockets. They appear under <em>Internal</em> and count as
          neither cost nor revenue.
        </p>
        <p className="text-sm leading-relaxed">
          <strong>Personal money is not business cost.</strong> A bank feed
          carries groceries next to servers, so cost is the business scope only,
          joined from each transaction&rsquo;s account to that
          account&rsquo;s books.
        </p>
        <p className="text-sm leading-relaxed">
          Everything is normalised to a monthly rate and then prorated onto the
          window you picked, because burn is a rate. The bank window is not the
          traffic range — bank data has no hourly resolution — so every panel
          names its own basis.
        </p>
        <p className="text-sm leading-relaxed">
          It also reports what it cannot know. A site that did not answer is
          shown as missing rather than zero, a vendor list built from one page
          of a longer ledger says so, and a fleet whose visits run far above its
          pageviews says that too. A &ldquo;visitor&rdquo; is any hit not
          classified as a crawler, which on a site with a machine-readable
          endpoint runs orders of magnitude above the pages anyone read, so the
          per-pageview figure sits beside the per-visitor one.
        </p>
      </section>

      <section className="mt-10 space-y-3">
        <h2 className="text-2xl font-bold">Money screens</h2>
        <p className="text-sm leading-relaxed">
          The Money and Spend screens read a bank and card feed through{" "}
          <a
            href="https://coinpayportal.com"
            className="underline"
            rel="noreferrer"
          >
            CoinPay
          </a>
          . They need a merchant session, which{" "}
          <code className="font-mono">coinpay auth login</code> writes to{" "}
          <code className="font-mono">~/.coinpay.json</code>. Without one the
          other three screens still work and the money panels say what is
          missing rather than showing zero.
        </p>
        <Cmd>{`crawlproof dashboard --no-coinpay   # skip them entirely`}</Cmd>
      </section>

      <section className="mt-10 space-y-3">
        <h2 className="text-2xl font-bold">Environment</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--color-border)] text-left text-[var(--color-muted)]">
                <th className="py-2 pr-4 font-medium">Variable</th>
                <th className="py-2 font-medium">Meaning</th>
              </tr>
            </thead>
            <tbody className="align-top">
              <tr className="border-b border-[var(--color-border)]">
                <td className="py-2 pr-4 font-mono text-xs">CRAWLPROOF_TOKEN</td>
                <td className="py-2">
                  API token. Falls back to the <code className="font-mono">token</code>{" "}
                  field of <code className="font-mono">~/.crawlproof.json</code>;{" "}
                  <code className="font-mono">--token</code> beats both.
                </td>
              </tr>
              <tr className="border-b border-[var(--color-border)]">
                <td className="py-2 pr-4 font-mono text-xs">CRAWLPROOF_SITE_URL</td>
                <td className="py-2">
                  API base, default <code className="font-mono">https://crawlproof.com</code>.
                </td>
              </tr>
              <tr className="border-b border-[var(--color-border)]">
                <td className="py-2 pr-4 font-mono text-xs">COINPAY_SESSION_TOKEN</td>
                <td className="py-2">
                  Merchant JWT for the money screens. Defaults to{" "}
                  <code className="font-mono">jwtToken</code> in{" "}
                  <code className="font-mono">~/.coinpay.json</code>.
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section className="mt-10 space-y-3">
        <h2 className="text-2xl font-bold">The API underneath</h2>
        <p className="text-sm leading-relaxed">
          Every command is HTTP with a bearer token, so anything can call it.
        </p>
        <Cmd>{`curl -H "Authorization: Bearer $CRAWLPROOF_TOKEN" \\
  https://crawlproof.com/api/tracker/v1/sites

curl -H "Authorization: Bearer $CRAWLPROOF_TOKEN" \\
  "https://crawlproof.com/api/tracker/v1/stats?site=example.com&range=1d"

curl -H "Authorization: Bearer $CRAWLPROOF_TOKEN" \\
  "https://crawlproof.com/api/ads/v1/earnings?days=30"`}</Cmd>
      </section>
    </main>
  );
}
