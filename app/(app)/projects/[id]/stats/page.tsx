import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ProjectShell } from "@/components/project-shell";
import { bucketLabel } from "@/lib/tracker/categorize";
import { env } from "@/lib/env";
import type { Engine } from "@/lib/credits";
import type { ProjectStatus } from "@/app/actions/projects";
import { InstallSnippet } from "./install-snippet";
import { TrackerToggle } from "./tracker-toggle";
import { AutoInstall } from "./auto-install";
import { getOrMintInstallationToken } from "@/lib/github/installations";
import { listInstallationRepos } from "@/lib/github/app";

type StatsRow = { bucket: string; day: string; count: number };

const WINDOW_DAYS = 30;

export default async function ProjectStatsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: project } = await supabase
    .from("projects")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (!project) notFound();

  const since = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const { data: stats } = await supabase
    .from("tracker_daily_stats")
    .select("bucket, day, count")
    .eq("project_id", id)
    .gte("day", since)
    .order("day", { ascending: false });

  const rows = (stats ?? []) as StatsRow[];

  // Roll up by bucket for the table view; sort by total desc.
  const byBucket = new Map<string, number>();
  let totalAi = 0;
  let totalBot = 0;
  let totalHuman = 0;
  for (const r of rows) {
    byBucket.set(r.bucket, (byBucket.get(r.bucket) ?? 0) + r.count);
    if (r.bucket.startsWith("ai_referral:")) totalAi += r.count;
    else if (r.bucket.startsWith("bot:")) totalBot += r.count;
    else if (r.bucket.startsWith("human:") || r.bucket.startsWith("search:") || r.bucket.startsWith("social:") || r.bucket.startsWith("referral:"))
      totalHuman += r.count;
  }
  const buckets = Array.from(byBucket.entries()).sort((a, b) => b[1] - a[1]);
  const grandTotal = buckets.reduce((s, [, n]) => s + n, 0);

  const trackerEnabled = !!(project as { tracker_enabled?: boolean })
    .tracker_enabled;

  // GitHub auto-install: best-effort. If env is missing or the user has
  // no connected installations, we just hide the button.
  const ghConfigured = !!(env.githubAppId && env.githubAppPrivateKey);
  const { data: { user } } = await supabase.auth.getUser();
  const installations: Array<{ installation_id: number; account_login: string }> = [];
  const ghRepos: Array<{ full_name: string; installation_id: number }> = [];
  if (ghConfigured && user) {
    const { data: rows } = await supabase
      .from("github_installations")
      .select("installation_id, account_login")
      .is("removed_at", null);
    for (const r of (rows ?? []) as Array<{ installation_id: number; account_login: string }>) {
      installations.push(r);
      try {
        const token = await getOrMintInstallationToken(r.installation_id);
        const repos = await listInstallationRepos(token);
        for (const repo of repos) {
          ghRepos.push({
            full_name: repo.full_name,
            installation_id: r.installation_id,
          });
        }
      } catch {
        // Skip this installation if listing fails; the settings page will
        // show the error.
      }
    }
  }

  return (
    <ProjectShell
      project={{
        id: project.id,
        name: project.name,
        url: project.url,
        schedule: project.schedule,
        status: (project.status ?? "active") as ProjectStatus,
        engines: (project.engines ?? ["rule"]) as Engine[],
        logo_url: (project as { logo_url?: string | null }).logo_url ?? null,
      }}
      currentTab="stats"
    >
      <div className="space-y-6">
        <section className="card p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2 mb-3">
            <div>
              <h2 className="text-lg font-semibold">Drop-in stats tracker</h2>
              <p className="text-sm text-[var(--color-muted)]">
                {trackerEnabled
                  ? "Live and accepting pageviews."
                  : "Disabled. Enable to start receiving events."}
              </p>
            </div>
            <TrackerToggle projectId={id} initialEnabled={trackerEnabled} />
          </div>
          {trackerEnabled && (
            <>
              <InstallSnippet projectId={id} siteUrl={env.siteUrl} />
              <div className="mt-3">
                <AutoInstall
                  projectId={id}
                  installations={installations}
                  repos={ghRepos}
                  notConfigured={!ghConfigured}
                />
              </div>
            </>
          )}
        </section>

        <div className="grid gap-3 sm:grid-cols-3">
          <Metric label="AI referrals" value={totalAi} tone="pass" />
          <Metric label="AI / bot crawls" value={totalBot} tone="warn" />
          <Metric label="Other visits" value={totalHuman} tone="muted" />
        </div>

        <section className="card p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2 mb-3">
            <h2 className="text-lg font-semibold">
              Last {WINDOW_DAYS} days
            </h2>
            <p className="text-xs text-[var(--color-muted)]">
              {grandTotal.toLocaleString()} total events
            </p>
          </div>
          {buckets.length === 0 ? (
            <p className="text-sm text-[var(--color-muted)]">
              {trackerEnabled
                ? "No events yet. Once the snippet is installed and your site gets traffic, sources will appear here."
                : "Enable the tracker to start collecting events."}
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--color-border)] text-left text-[var(--color-muted)]">
                  <th className="py-1 font-normal">Source</th>
                  <th className="py-1 text-right font-normal">Events</th>
                  <th className="py-1 text-right font-normal">Share</th>
                </tr>
              </thead>
              <tbody>
                {buckets.map(([bucket, count]) => {
                  const share = grandTotal ? (count / grandTotal) * 100 : 0;
                  return (
                    <tr
                      key={bucket}
                      className="border-b border-[var(--color-border)] last:border-0"
                    >
                      <td className="py-1.5">{bucketLabel(bucket)}</td>
                      <td className="py-1.5 text-right tabular-nums">
                        {count.toLocaleString()}
                      </td>
                      <td className="py-1.5 text-right tabular-nums text-[var(--color-muted)]">
                        {share.toFixed(1)}%
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </ProjectShell>
  );
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "pass" | "warn" | "muted";
}) {
  const color =
    tone === "pass"
      ? "text-green-600"
      : tone === "warn"
        ? "text-yellow-600"
        : "text-[var(--color-foreground)]";
  return (
    <div className="card p-4">
      <p className="text-xs text-[var(--color-muted)]">{label}</p>
      <p className={`mt-1 text-2xl font-bold ${color}`}>
        {value.toLocaleString()}
      </p>
    </div>
  );
}
