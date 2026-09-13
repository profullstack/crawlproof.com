import Link from "next/link";
import { listDirectory } from "@/lib/affiliate/directory";
import { linkFor } from "@/lib/affiliate/spec";

export const metadata = {
  title: "Affiliate programs you can join — read from each merchant's own file",
  description: "A directory of OpenAffiliate programs: what each merchant pays, for how long, with what hold, read from /.well-known/openaffiliate.json on the merchant's own origin.",
  alternates: { canonical: "/affiliate/programs" },
};
export const revalidate = 300;

function pays(p: Array<{ event: string; kind: string; value: number; months?: number }>): string {
  return p.map((x) => `${x.kind === "percent" ? `${x.value}%` : `$${x.value}`} per ${x.event}${x.months ? ` × ${x.months} months` : ""}`).join(", ");
}

export default async function ProgramsDirectoryPage() {
  const programs = await listDirectory();
  return (
    <main className="mx-auto max-w-5xl px-4 py-16 sm:px-6">
      <p className="mb-3 text-sm font-medium uppercase tracking-wider text-[var(--color-accent)]">OpenAffiliate directory</p>
      <h1 className="text-4xl font-extrabold">Programs you can join</h1>
      <p className="mt-4 max-w-2xl text-lg text-[var(--color-muted)]">
        Every row was read from the merchant&apos;s own <code className="font-mono text-sm">/.well-known/openaffiliate.json</code>. Verified means it came from the merchant&apos;s origin; the terms are shown with the time they were read, and the merchant&apos;s own terms link beside them. Nothing here takes a share of anything.
      </p>
      <div className="mt-6 flex gap-3">
        <Link href="/signup" className="btn btn-primary">
          Join from your dashboard
        </Link>
        <a href="https://logicsrc.com/openaffiliate" className="btn">
          Run one yourself
        </a>
      </div>
      {programs.length === 0 ? (
        <p className="card mt-8 p-6 text-[var(--color-muted)]">No merchants read yet.</p>
      ) : (
        <ul className="mt-8 space-y-3">
          {programs.map((p) => (
            <li key={`${p.origin}|${p.program.id}`} className="card p-5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h2 className="text-lg font-semibold">
                    <a href={p.program.url ?? p.merchant.web ?? p.origin} className="hover:text-[var(--color-accent)]">
                      {p.merchant.name}
                    </a>{" "}
                    <span className="text-[var(--color-muted)]">· {p.program.title}</span>
                  </h2>
                  <p className="text-sm text-[var(--color-muted)]">{p.origin.replace(/^https?:\/\//, "")}</p>
                </div>
                <div className="flex items-center gap-2">
                  {p.verified ? <span className="badge badge-pass">verified</span> : <span className="badge">claimed</span>}
                  <span className="badge">{p.program.approval}</span>
                  {p.program.status !== "active" ? <span className="badge">{p.program.status}</span> : null}
                </div>
              </div>
              <dl className="mt-3 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
                <div>
                  <dt className="text-[var(--color-muted)]">Pays</dt>
                  <dd>{pays(p.program.pays)}</dd>
                </div>
                <div>
                  <dt className="text-[var(--color-muted)]">Window and hold</dt>
                  <dd>
                    {p.program.window ? `${p.program.window} days, ${p.program.attribution} touch` : "window unstated"}
                    {p.program.hold_days ? `; ${p.program.hold_days}-day hold` : "; hold unstated"}
                  </dd>
                </div>
                <div>
                  <dt className="text-[var(--color-muted)]">Payout</dt>
                  <dd>
                    {p.program.payout?.methods.length ? p.program.payout.methods.join(", ") : "unstated"}
                    {p.program.payout?.min !== undefined ? ` from ${p.program.payout.min} ${p.merchant.currency}` : ""}
                    {p.program.payout?.schedule ? `, ${p.program.payout.schedule.replace("_", " ")}` : ""}
                  </dd>
                </div>
                <div>
                  <dt className="text-[var(--color-muted)]">Link shape</dt>
                  <dd className="font-mono text-xs">{linkFor(p.program, "you", p.merchant.web ?? p.origin) ?? "unstated"}</dd>
                </div>
              </dl>
              <p className="mt-3 text-xs text-[var(--color-muted)]">
                Read {p.fetchedAt ? new Date(p.fetchedAt).toUTCString() : "at an unknown time"}.
                {p.merchant.terms ? (
                  <>
                    {" "}
                    <a className="underline" href={p.merchant.terms}>
                      Merchant&apos;s terms
                    </a>
                    .
                  </>
                ) : null}
              </p>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
