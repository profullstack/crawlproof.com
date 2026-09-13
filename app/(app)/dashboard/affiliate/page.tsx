import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { ensureMembershipForUser, ledgerFor, profileUrlForMembership } from "@/lib/affiliate/memberships";
import { listDirectory, listJoins } from "@/lib/affiliate/directory";
import { HOLD_DAYS, PAYOUT_MIN_CENTS, WINDOW_DAYS, termsLine } from "@/lib/affiliate/program";
import { AddProgramForm, CopyField, JoinButton, PayForm, PayoutButton, SyncButton, TokenButton, WebhookForm } from "@/components/affiliate/controls";

export const metadata = { title: "Affiliate" };
export const dynamic = "force-dynamic";

const money = (n: number) => `$${n.toFixed(2)}`;

function describePays(pays: Array<{ event: string; kind: string; value: number; months?: number }>): string {
  return pays
    .map((p) => `${p.kind === "percent" ? `${p.value}%` : `$${p.value}`} per ${p.event}${p.months ? ` for ${p.months} months` : ""}`)
    .join(", ");
}

export default async function AffiliatePage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const membership = await ensureMembershipForUser({ id: user.id, email: user.email ?? null });
  if (!membership) {
    return (
      <div className="mx-auto max-w-4xl">
        <h1 className="text-3xl font-bold">Affiliate</h1>
        <p className="card mt-6 p-6 text-[var(--color-muted)]">The affiliate program is not set up on this deployment yet.</p>
      </div>
    );
  }
  const [ledger, joins, directory] = await Promise.all([ledgerFor(membership), listJoins(user.id), listDirectory()]);
  const joinedKeys = new Set(joins.filter((j) => j.status !== "refused" && j.status !== "ended").map((j) => `${j.origin.toLowerCase()}|${j.programId}`));
  const site = process.env.NEXT_PUBLIC_SITE_URL ?? "";
  const others = directory.filter((p) => !site || p.origin.replace(/\/$/, "") !== site.replace(/\/$/, ""));

  return (
    <div className="mx-auto max-w-4xl">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-3xl font-bold">Affiliate</h1>
        <Link href="/affiliate" className="btn">
          How it works
        </Link>
      </div>
      <p className="mt-2 text-[var(--color-muted)]">
        Earn {termsLine().toLowerCase()} And join any other merchant that runs an{" "}
        <a href="https://logicsrc.com/openaffiliate" className="underline">
          OpenAffiliate
        </a>{" "}
        program, from here, with one profile.
      </p>

      <section className="card mt-6 p-5">
        <h2 className="text-lg font-semibold">Your link</h2>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          Any page on this site works with <code className="font-mono">?oa={membership.code}</code> added. A click starts a {WINDOW_DAYS}-day window; a purchase in it is yours.
        </p>
        <div className="mt-3">
          <CopyField value={ledger.link} label="affiliate link" />
        </div>
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Clicks, all time" value={String(ledger.clicks.total)} />
          <Stat label={`Clicks, ${WINDOW_DAYS}d`} value={String(ledger.clicks.window)} />
          <Stat label="Pending" value={money(ledger.balance.pending)} hint={`held ${HOLD_DAYS} days`} />
          <Stat label="Approved" value={money(ledger.balance.approved)} hint={`paid ${money(ledger.balance.paid)} so far`} />
        </div>
      </section>

      <section className="card mt-4 p-5">
        <h2 className="text-lg font-semibold">Getting paid</h2>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          USDC on Polygon, weekly, once the approved balance reaches ${(PAYOUT_MIN_CENTS / 100).toFixed(0)}. Or send it now.
        </p>
        <div className="mt-3 space-y-3">
          <PayForm initial={membership.payAddress ?? ""} />
          <PayoutButton approved={ledger.balance.approved} min={PAYOUT_MIN_CENTS / 100} hasAddress={!!membership.payAddress} />
        </div>
      </section>

      <section className="card mt-4 p-5">
        <h2 className="text-lg font-semibold">Conversions</h2>
        {ledger.conversions.length === 0 ? (
          <p className="mt-2 text-sm text-[var(--color-muted)]">None yet. Every purchase attributed to your link lands here with its status and hold.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-[var(--color-muted)]">
                <tr>
                  <th className="py-1 pr-3">When</th>
                  <th className="py-1 pr-3">Event</th>
                  <th className="py-1 pr-3">Amount</th>
                  <th className="py-1 pr-3">Commission</th>
                  <th className="py-1 pr-3">Status</th>
                </tr>
              </thead>
              <tbody>
                {ledger.conversions.slice(0, 50).map((c) => (
                  <tr key={c.id} className="border-t border-[var(--color-border,rgba(127,127,127,.2))]">
                    <td className="py-1 pr-3 whitespace-nowrap">{c.at.slice(0, 10)}</td>
                    <td className="py-1 pr-3">{c.event}</td>
                    <td className="py-1 pr-3">{money(c.amount)}</td>
                    <td className="py-1 pr-3">{money(c.commission)}</td>
                    <td className="py-1 pr-3">
                      <span className="badge">{c.status}</span>
                      {c.status === "pending" && c.held_until ? <span className="ml-2 text-[var(--color-muted)]">until {c.held_until.slice(0, 10)}</span> : null}
                      {c.reason ? <span className="ml-2 text-[var(--color-muted)]">{c.reason}</span> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {ledger.payouts.length > 0 && (
          <ul className="mt-3 space-y-1 text-sm text-[var(--color-muted)]">
            {ledger.payouts.slice(0, 10).map((p) => (
              <li key={p.id}>
                {p.at.slice(0, 10)}: {money(p.amount)} {p.status}
                {p.tx ? (
                  <>
                    {" "}
                    <a className="underline" href={`https://polygonscan.com/tx/${p.tx}`} target="_blank" rel="noreferrer">
                      tx
                    </a>
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card mt-4 p-5">
        <h2 className="text-lg font-semibold">Programs you have joined</h2>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          Other merchants&apos; programs, joined with your profile at <code className="font-mono text-xs">{profileUrlForMembership(membership)}</code>. Their ledgers are read daily and on demand.
        </p>
        {joins.length === 0 ? (
          <p className="mt-2 text-sm text-[var(--color-muted)]">None yet. Pick one below, or paste a merchant&apos;s URL.</p>
        ) : (
          <ul className="mt-3 space-y-2">
            {joins.map((j) => {
              const bal = (j.ledger?.balance ?? null) as { pending?: number; approved?: number; paid?: number } | null;
              return (
                <li key={j.id} className="rounded border border-[var(--color-border,rgba(127,127,127,.2))] p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="font-semibold">
                        {j.origin.replace(/^https?:\/\//, "")} <span className="text-[var(--color-muted)]">· {j.programId}</span>
                      </div>
                      <div className="text-sm text-[var(--color-muted)]">
                        <span className="badge">{j.status}</span>
                        {bal ? ` pending ${money(bal.pending ?? 0)} · approved ${money(bal.approved ?? 0)} · paid ${money(bal.paid ?? 0)}` : " no ledger read yet"}
                        {j.error ? ` · ${j.error}` : ""}
                      </div>
                    </div>
                    <SyncButton id={j.id} />
                  </div>
                  {j.link ? (
                    <div className="mt-2">
                      <CopyField value={j.link} label="link" />
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="card mt-4 p-5">
        <h2 className="text-lg font-semibold">Programs to join</h2>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          Every merchant here was read from its own <code className="font-mono text-xs">/.well-known/openaffiliate.json</code>. Add one by URL.
        </p>
        <div className="mt-3">
          <AddProgramForm />
        </div>
        {others.length === 0 ? (
          <p className="mt-3 text-sm text-[var(--color-muted)]">No other merchants read yet.</p>
        ) : (
          <ul className="mt-3 space-y-2">
            {others.map((p) => (
              <li key={`${p.origin}|${p.program.id}`} className="flex flex-wrap items-center justify-between gap-2 rounded border border-[var(--color-border,rgba(127,127,127,.2))] p-3">
                <div className="min-w-0">
                  <div className="font-semibold">
                    {p.merchant.name} <span className="text-[var(--color-muted)]">· {p.program.title}</span>
                    {p.verified ? <span className="badge badge-pass ml-2">verified</span> : <span className="badge ml-2">claimed</span>}
                  </div>
                  <div className="text-sm text-[var(--color-muted)]">
                    {describePays(p.program.pays)}
                    {p.program.window ? ` · ${p.program.window}-day window` : ""}
                    {p.program.hold_days ? ` · ${p.program.hold_days}-day hold` : ""}
                    {` · ${p.program.approval}`}
                  </div>
                </div>
                <JoinButton origin={p.origin} program={p.program.id} joined={joinedKeys.has(`${p.origin.toLowerCase()}|${p.program.id}`)} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card mt-4 p-5">
        <h2 className="text-lg font-semibold">For agents and scripts</h2>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          Your API token works on every <code className="font-mono text-xs">/api/affiliate/v1/*</code> route and in <code className="font-mono text-xs">crawlproof affiliate</code>. The affiliate token below reads only the ledger, which is what you hand to a third party.
        </p>
        <div className="mt-3 space-y-3">
          <TokenButton prefix={membership.tokenPrefix} />
          <WebhookForm initial={membership.webhookUrl ?? ""} />
        </div>
      </section>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded border border-[var(--color-border,rgba(127,127,127,.2))] p-3">
      <div className="text-xs uppercase tracking-wide text-[var(--color-muted)]">{label}</div>
      <div className="text-xl font-semibold">{value}</div>
      {hint ? <div className="text-xs text-[var(--color-muted)]">{hint}</div> : null}
    </div>
  );
}
