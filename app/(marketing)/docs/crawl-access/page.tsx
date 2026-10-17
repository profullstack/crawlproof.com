import Link from "next/link";
import {
  CRAWL_MAX_DAYS,
  CRAWL_PASS_MINUTES,
  POWER_KEY_SHOP,
  sampleReceipt,
} from "@/lib/crawl-offer";

const SITE = "https://crawlproof.com";

export const metadata = {
  title: "Crawler access ($1/day pass)",
  description:
    "What the HTTP 402 at crawlproof.com/crawl is, what the $1 USDC crawler pass buys (24 hours of every public page), the exact receipt it returns, and how to pay with or without an x402 client.",
  alternates: { canonical: "/docs/crawl-access" },
};

function Code({ children }: { children: string }) {
  return (
    <pre className="mt-3 overflow-x-auto rounded border border-[var(--color-border)] bg-[#0b0d10] p-3 font-mono text-xs leading-relaxed text-white">
      {children}
    </pre>
  );
}

export default function CrawlAccessDocsPage() {
  return (
    <main className="mx-auto max-w-3xl px-4 py-16 sm:px-6">
      <p className="text-sm">
        <Link href="/docs" className="text-[var(--color-muted)] hover:underline">
          ← Docs
        </Link>
      </p>
      <h1 className="mt-2 text-4xl font-extrabold">Crawler access: $1 a day</h1>

      <section className="mt-6 card p-5">
        <h2 className="text-lg font-bold">In one paragraph</h2>
        <p className="mt-2">
          <code className="font-mono">GET {SITE}/crawl</code> answers{" "}
          <strong>402 Payment Required</strong> on purpose. It is not an error,
          not a test and not the site audit. It sells a <strong>crawler pass</strong>:{" "}
          <strong>$1 USDC buys 24 hours ({CRAWL_PASS_MINUTES} minutes)</strong> of
          automated access to every public page on crawlproof.com, up to{" "}
          {CRAWL_MAX_DAYS} days in one payment. Paying returns a JSON receipt
          with a signed token; you send that token in the{" "}
          <code className="font-mono">x-crawl-pass</code> header on each request.
        </p>
        <p className="mt-2 text-sm text-[var(--color-muted)]">
          People, search engines and AI retrieval crawlers that cite their
          sources never need a pass. Want to audit your own site? The{" "}
          <Link href="/" className="underline">free AEO audit</Link> needs no payment.
        </p>
      </section>

      <section className="mt-10 space-y-3">
        <h2 className="text-2xl font-bold">What the $1 buys</h2>
        <ul className="list-disc space-y-1 pl-5">
          <li>Read access to every public page on crawlproof.com for 24 hours from payment.</li>
          <li>
            More days in one payment: <code className="font-mono">{SITE}/crawl?days=7</code> quotes $7
            for 7 days (max {CRAWL_MAX_DAYS}).
          </li>
          <li>No account, API key or subscription.</li>
        </ul>
        <p className="text-sm text-[var(--color-muted)]">
          Not included: account access, the paid audit engines, or exemption
          from rate limits (12 requests per minute per IP, 600 per hour per
          crawler family; honour <code className="font-mono">Retry-After</code>).
          Automated ad-link requests never count as ad clicks.
        </p>
      </section>

      <section className="mt-10 space-y-3">
        <h2 className="text-2xl font-bold">What /crawl returns once paid</h2>
        <p>A <code className="font-mono">200</code> with exactly this shape:</p>
        <Code>{JSON.stringify(sampleReceipt(SITE), null, 2)}</Code>
        <p>Then send the pass on every request until it expires:</p>
        <Code>{`curl -H "x-crawl-pass: cp_..." ${SITE}/blog`}</Code>
      </section>

      <section className="mt-10 space-y-3">
        <h2 className="text-2xl font-bold">How to pay</h2>
        <h3 className="font-bold">Without an x402 client</h3>
        <ul className="list-disc space-y-2 pl-5">
          <li>
            <strong>Browser wallet, one command.</strong> Opens a tab to approve
            $1 USDC with MetaMask, Rabby, Coinbase Wallet or the CoinPay Wallet,
            then writes the receipt to <code className="font-mono">pass.json</code>:
            <Code>{`npx @profullstack/coinpay x402 pay ${SITE}/crawl --output pass.json`}</Code>
          </li>
          <li>
            <strong>Power Key.</strong> A one-time crypto checkout through
            CoinPay (USDC, ETH, BTC, SOL) at{" "}
            <a className="underline" href={POWER_KEY_SHOP}>profullstack.com/shop</a>.
            It opens crawlproof.com and every other Profullstack site with no
            day passes. Send it as <code className="font-mono">x-power-key</code> or{" "}
            <code className="font-mono">Authorization: Bearer pfs_...</code>.
          </li>
          <li>
            <strong>Invoice or bulk access.</strong> Email{" "}
            <a className="underline" href="mailto:support@crawlproof.com">support@crawlproof.com</a>.
          </li>
        </ul>
        <h3 className="pt-2 font-bold">With an x402 client</h3>
        <p>
          The 402 body is a standard x402 v2 offer: scheme{" "}
          <code className="font-mono">exact</code>, 1000000 units (1.00 USDC) on
          Base (<code className="font-mono">eip155:8453</code>), Polygon (
          <code className="font-mono">eip155:137</code>) or Ethereum (
          <code className="font-mono">eip155:1</code>). Sign an EIP-3009
          authorization for one entry and retry with it in{" "}
          <code className="font-mono">X-PAYMENT</code>. Settlement is by CoinPay,
          whose relayer pays the gas.
        </p>
        <Code>{`curl -sS -H "Accept: application/json" ${SITE}/crawl   # 402 + offer
curl -sS -H "X-PAYMENT: <base64 proof>" ${SITE}/crawl  # 200 + receipt`}</Code>
        <p className="text-sm text-[var(--color-muted)]">
          Besides the protocol fields, the 402 body carries an{" "}
          <code className="font-mono">about</code> object with this page&apos;s
          summary, the sample receipt and these payment options, so an agent can
          decide without leaving the response.
        </p>
      </section>
    </main>
  );
}
