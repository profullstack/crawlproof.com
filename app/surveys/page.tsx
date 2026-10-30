import Link from "next/link";

export const metadata = {
  title: "Surveys · CrawlProof",
  description: "Ask one focused question across your sites. Send survey invitations by email or SMS with consent, compare invitation copy, and review responses.",
};

export default function SurveysLandingPage() {
  return (
    <main className="mx-auto max-w-5xl px-4 py-16 sm:px-6">
      <div className="max-w-3xl">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--color-accent)]">CrawlProof Surveys</p>
        <h1 className="mt-4 text-4xl font-bold tracking-tight sm:text-5xl">One useful question. Across every site you manage.</h1>
        <p className="mt-5 max-w-2xl text-lg text-[var(--color-muted)]">Create a short survey for a site in your workspace, send a consent-based email or text invitation, test two invitation versions, and see responses together.</p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Link href="/dashboard/surveys" className="btn btn-primary">Open surveys</Link>
          <Link href="/dashboard" className="btn">Go to dashboard</Link>
        </div>
      </div>
      <div className="mt-14 grid gap-4 md:grid-cols-3">
        <article className="card p-5"><h2 className="font-semibold">Use your site directory</h2><p className="mt-2 text-sm text-[var(--color-muted)]">Surveys are connected to the sites already grouped in a CrawlProof workspace.</p></article>
        <article className="card p-5"><h2 className="font-semibold">Contact people on their terms</h2><p className="mt-2 text-sm text-[var(--color-muted)]">Email and SMS have separate opt-ins. Email is a fallback only when the recipient approved email too.</p></article>
        <article className="card p-5"><h2 className="font-semibold">Learn which invite works</h2><p className="mt-2 text-sm text-[var(--color-muted)]">Recipients stay in one invitation variant, so response rates compare A and B fairly.</p></article>
      </div>
    </main>
  );
}
