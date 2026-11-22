import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { serviceClient } from "@/lib/supabase/service";
import { experimentStats, listExperiments } from "@/lib/abtest/store";

export const metadata = { title: "Experiments · CrawlProof" };
export const dynamic = "force-dynamic";

const pct = (x: number) => `${(x * 100).toFixed(x < 0.1 ? 2 : 1)}%`;

export default async function ExperimentsPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const sb = serviceClient();
  const experiments = await listExperiments(sb, user.id).catch(() => []);
  const summaries = await Promise.all(experiments.map((e) => experimentStats(sb, e).catch(() => null)));

  return (
    <div className="mx-auto max-w-5xl space-y-8">
      <header>
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--color-accent)]">A/B tests</p>
        <h1 className="mt-2 text-3xl font-bold">Experiments</h1>
        <p className="mt-2 max-w-2xl text-sm text-[var(--color-muted)]">
          Sticky arms per user, exposures, conversions and revenue from your products, with the conversion rate per arm, a 95% interval,
          a two-proportion z test and the probability each arm beats the control. Products report through the API with a{" "}
          <Link href="/dashboard/api-tokens" className="underline">crp_ token</Link> and{" "}
          <a href="https://www.npmjs.com/package/@profullstack/abtest" className="underline">@profullstack/abtest</a>.
        </p>
      </header>

      {experiments.length === 0 ? (
        <section className="card p-8">
          <h2 className="text-xl font-semibold">No experiments yet</h2>
          <pre className="mt-4 overflow-x-auto rounded bg-black/30 p-4 text-xs">{`import { createClient } from "@profullstack/abtest";
const ab = createClient({ token: process.env.CRAWLPROOF_TOKEN });
await ab.experiment({ key: "trial-length", arms: ["30d", "90d"], control: "90d" });
const { arm } = await ab.assign("trial-length", user.id, ["30d", "90d"]);
await ab.exposure("trial-length", user.id, { id: "exposure:" + user.id });
await ab.conversion("trial-length", user.id, { id: "paid:" + paymentId });
await ab.revenue("trial-length", user.id, 19, { id: "rev:" + paymentId });`}</pre>
        </section>
      ) : (
        <div className="grid gap-3">
          {experiments.map((e, i) => {
            const s = summaries[i];
            return (
              <Link key={e.id} href={`/dashboard/experiments/${encodeURIComponent(e.key)}`} className="card block p-5 transition hover:border-[var(--color-accent)]">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <h2 className="text-lg font-semibold">{e.name}</h2>
                    <p className="mt-1 font-mono text-xs text-[var(--color-muted)]">{e.key}</p>
                  </div>
                  <span className={`badge ${e.status === "running" ? "badge-pass" : ""}`}>{e.status}</span>
                </div>
                {s && (
                  <p className="mt-3 text-sm">
                    {s.arms.map((a) => `${a.arm}: ${a.converted}/${a.exposed} (${pct(a.rate)})`).join(" · ")}
                  </p>
                )}
                {s && <p className="mt-2 text-xs text-[var(--color-muted)]">{s.verdict.text}</p>}
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
