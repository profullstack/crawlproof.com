import { SignupForm } from "./signup-form";

export const metadata = {
  title: "Free web alerts — CrawlProof Alerts",
  description:
    "Free, near-realtime email alerts for anything Google can see: brand mentions, new backlinks, buying-intent searches, and more. Email only — no password, no card.",
};

export default function GetAlertsPage() {
  return (
    <main className="mx-auto max-w-2xl px-4 py-16 sm:px-6">
      <div className="text-center">
        <h1 className="text-3xl font-bold sm:text-4xl">Know the moment the web mentions you</h1>
        <p className="mx-auto mt-3 max-w-xl text-[var(--color-muted)]">
          Free email alerts for brand mentions, new backlinks, competitor moves, and buying-intent searches —
          powered by Google, verified by CrawlProof&apos;s crawler. Start with just your email.
        </p>
      </div>
      <div className="mt-8">
        <SignupForm />
      </div>
      <div className="mt-10 grid gap-4 sm:grid-cols-3 text-center text-sm">
        <div className="card">
          <div className="font-semibold">Backlinks, verified</div>
          <p className="mt-1 text-xs text-[var(--color-muted)]">
            We crawl each candidate and confirm a real link exists — not just a mention.
          </p>
        </div>
        <div className="card">
          <div className="font-semibold">No noise</div>
          <p className="mt-1 text-xs text-[var(--color-muted)]">
            Only never-seen-before results, batched into one clean daily digest.
          </p>
        </div>
        <div className="card">
          <div className="font-semibold">Free that works</div>
          <p className="mt-1 text-xs text-[var(--color-muted)]">
            Up to 50 alerts, checked daily. Upgrade for hourly and more.
          </p>
        </div>
      </div>
    </main>
  );
}
