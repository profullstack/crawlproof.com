export const metadata = {
  title: "Terms",
  alternates: { canonical: "/terms" },
};

export default function TermsPage() {
  return (
    <main className="mx-auto max-w-3xl px-4 sm:px-6 py-16">
      <h1 className="text-4xl font-extrabold">Terms of Service</h1>
      <div className="prose mt-6 text-[var(--color-muted)]">
        <p>
          Use of CrawlProof is governed by these terms. By using the service you
          agree to use it only on sites you own or are authorized to audit, to
          respect rate limits, and not to use it to attack or overload third-party
          systems.
        </p>
      </div>
    </main>
  );
}
