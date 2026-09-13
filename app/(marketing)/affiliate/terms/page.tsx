import { HOLD_DAYS, PAYOUT_MIN_CENTS, PAYS, WINDOW_DAYS } from "@/lib/affiliate/program";

export const metadata = {
  title: "Affiliate program terms",
  description: "The terms of the CrawlProof partner program, the same ones served at /.well-known/openaffiliate.json.",
  alternates: { canonical: "/affiliate/terms" },
};

export default function AffiliateTermsPage() {
  const sale = PAYS.find((p) => p.event === "sale");
  const rate = sale?.kind === "percent" ? `${sale.value} percent of the amount paid` : sale ? `$${sale.value}` : "nothing";
  return (
    <main className="mx-auto max-w-3xl px-4 py-16 sm:px-6">
      <h1 className="text-3xl font-bold">Partner program terms</h1>
      <p className="mt-2 text-sm text-[var(--color-muted)]">
        These are the terms in prose. The machine-readable copy at <code className="font-mono text-xs">/.well-known/openaffiliate.json</code> is the same terms, and where the two differ the file is what the ledger pays.
      </p>
      <ol className="mt-6 list-decimal space-y-3 pl-6">
        <li>
          <strong>Who may join.</strong> Anyone with an account here, and any person, agent or organisation with an OpenProfile.md. Joining is open: a membership is active at once. We may end a membership for fraud, for sending traffic that breaks the law or our terms of service, or for misrepresenting CrawlProof, and we say why.
        </li>
        <li>
          <strong>What pays.</strong> A credits purchase completed within {WINDOW_DAYS} days of a click on your link pays {rate}, net of tax and any refund. Sign-ups, views and clicks pay nothing on their own. Your own purchases pay nothing.
        </li>
        <li>
          <strong>Attribution.</strong> Only a real page visit carrying <code className="font-mono text-xs">?oa=yourcode</code> starts the window. A later click by a different affiliate replaces it. A parameter on an image, frame, script or prefetch sets nothing; placing one is grounds to end the membership.
        </li>
        <li>
          <strong>Hold and reversal.</strong> A conversion is pending for {HOLD_DAYS} days, then approved. A refund or chargeback in that time reverses it, and every reversal carries its reason in your ledger.
        </li>
        <li>
          <strong>Payment.</strong> Approved commission is sent in USDC on Polygon to the address on your membership, weekly, once it reaches ${(PAYOUT_MIN_CENTS / 100).toFixed(0)}, or sooner on request. We send the whole approved balance and take nothing from it. The transaction hash is in your ledger.
        </li>
        <li>
          <strong>Disclosure.</strong> Say it is a paid partner link where the law where you are asks you to. We ask for the words &quot;paid partner link&quot; or their equivalent.
        </li>
        <li>
          <strong>Changes.</strong> Terms change forward only. A conversion keeps the terms that stood when its click happened, and a change is announced in the file&apos;s <code className="font-mono text-xs">updated</code> field and by webhook to memberships that gave one.
        </li>
        <li>
          <strong>Your data.</strong> Your ledger shows an opaque order handle and amounts, never the customer. We keep click records for the window plus the hold and delete them after.
        </li>
      </ol>
      <p className="mt-6 text-sm text-[var(--color-muted)]">
        This program follows <a className="underline" href="https://logicsrc.com/docs/openaffiliate">OpenAffiliate 0.1</a>. Operator: Profullstack, Inc.
      </p>
    </main>
  );
}
