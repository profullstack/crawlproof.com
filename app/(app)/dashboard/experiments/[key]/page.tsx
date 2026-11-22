import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { serviceClient } from "@/lib/supabase/service";
import { experimentStats, getExperiment } from "@/lib/abtest/store";

export const metadata = { title: "Experiment · CrawlProof" };
export const dynamic = "force-dynamic";

const pct = (x: number) => `${(x * 100).toFixed(x < 0.1 ? 2 : 1)}%`;
const money = (x: number) => `$${x.toFixed(2)}`;

export default async function ExperimentPage({ params }: { params: Promise<{ key: string }> }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  const { key } = await params;

  const sb = serviceClient();
  const exp = await getExperiment(sb, user.id, decodeURIComponent(key));
  if (!exp) notFound();
  const s = await experimentStats(sb, exp);
  const eventNames = [...new Set(s.arms.flatMap((a) => Object.keys(a.events)))].sort();
  const labels = new Map(exp.arms.map((a) => [a.key, a.label]));

  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <header>
        <Link href="/dashboard/experiments" className="text-sm text-[var(--color-muted)]">← Experiments</Link>
        <div className="mt-2 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold">{exp.name}</h1>
            <p className="mt-1 font-mono text-xs text-[var(--color-muted)]">{exp.key} · started {new Date(exp.created_at).toLocaleDateString()}</p>
          </div>
          <span className={`badge ${exp.status === "running" ? "badge-pass" : ""}`}>{exp.status}{exp.winner ? ` · winner ${exp.winner}` : ""}</span>
        </div>
        {exp.description && <p className="mt-3 max-w-3xl text-sm text-[var(--color-muted)]">{exp.description}</p>}
      </header>

      <section className={`card p-5 ${s.verdict.status === "significant" ? "border-[var(--color-accent)]" : ""}`}>
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--color-muted)]">Verdict</p>
        <p className="mt-2 text-lg">{s.verdict.text}</p>
        <p className="mt-2 text-xs text-[var(--color-muted)]">
          Conversion = exposed units that converted at least once. Significance at α = {s.alpha}
          {s.arms.length > 2 ? ` (Bonferroni across ${s.arms.length - 1} challengers)` : ""}; nothing is read until every arm has {s.minPerArm} exposed units.
          Revenue per exposed unit is shown but not tested.
        </p>
      </section>

      <section className="card overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wide text-[var(--color-muted)]">
            <tr>
              <th className="p-3">Arm</th>
              <th className="p-3 text-right">Assigned</th>
              <th className="p-3 text-right">Exposed</th>
              <th className="p-3 text-right">Converted</th>
              <th className="p-3 text-right">Rate (95% CI)</th>
              <th className="p-3 text-right">Lift</th>
              <th className="p-3 text-right">p</th>
              <th className="p-3 text-right">P(beats control)</th>
              <th className="p-3 text-right">Revenue</th>
              <th className="p-3 text-right">Rev / exposed</th>
            </tr>
          </thead>
          <tbody>
            {s.arms.map((a) => (
              <tr key={a.arm} className="border-t border-[var(--color-border)]">
                <td className="p-3">
                  <span className="font-semibold">{labels.get(a.arm) ?? a.arm}</span>
                  <span className="ml-2 font-mono text-xs text-[var(--color-muted)]">{a.arm}</span>
                  {a.isControl && <span className="badge ml-2">control</span>}
                </td>
                <td className="p-3 text-right tabular-nums">{a.assigned}</td>
                <td className="p-3 text-right tabular-nums">{a.exposed}</td>
                <td className="p-3 text-right tabular-nums">{a.converted}</td>
                <td className="p-3 text-right tabular-nums">{pct(a.rate)} <span className="text-xs text-[var(--color-muted)]">({pct(a.ci.low)} to {pct(a.ci.high)})</span></td>
                <td className="p-3 text-right tabular-nums">{a.lift === null ? "–" : `${a.lift >= 0 ? "+" : ""}${(a.lift * 100).toFixed(1)}%`}</td>
                <td className="p-3 text-right tabular-nums">{a.pValue === null ? "–" : a.pValue.toPrecision(2)}</td>
                <td className="p-3 text-right tabular-nums">{a.probabilityToBeatControl === null ? "–" : pct(a.probabilityToBeatControl)}</td>
                <td className="p-3 text-right tabular-nums">{money(a.revenue)}</td>
                <td className="p-3 text-right tabular-nums">{money(a.revenuePerExposed)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {eventNames.length > 0 && (
        <section className="card overflow-x-auto p-0">
          <h2 className="p-4 pb-0 text-lg font-semibold">Engagement</h2>
          <table className="mt-2 w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-[var(--color-muted)]">
              <tr>
                <th className="p-3">Event</th>
                {s.arms.map((a) => <th key={a.arm} className="p-3 text-right">{a.arm}: units · total · per exposed</th>)}
              </tr>
            </thead>
            <tbody>
              {eventNames.map((n) => (
                <tr key={n} className="border-t border-[var(--color-border)]">
                  <td className="p-3 font-mono">{n}</td>
                  {s.arms.map((a) => {
                    const e = a.events[n];
                    return <td key={a.arm} className="p-3 text-right tabular-nums">{e ? `${e.units} · ${e.count} · ${e.perExposed.toFixed(2)}` : "0"}</td>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <p className="text-xs text-[var(--color-muted)]">
        API: <code>GET /api/abtest/v1/experiments/{exp.key}</code> · CLI: <code>CRAWLPROOF_TOKEN=crp_… npx @profullstack/abtest stats {exp.key}</code> ·
        stop with <code>PATCH {"{"}&quot;status&quot;:&quot;stopped&quot;,&quot;winner&quot;:&quot;…&quot;{"}"}</code>.
      </p>
    </div>
  );
}
