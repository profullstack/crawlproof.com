// Per-project "Security" tab — exposed-services / port-drift scans
// (docs/uptime-monitoring-prd.md §12). Shows open findings (ports open to the
// public internet that aren't in the accepted baseline) and recent scan history.
// The actual scanning runs on the off-Railway prober droplet; this page requests
// scans and displays their results. Degrades to an empty state if the migration
// isn't applied yet.

import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { RequestScanButton } from "./request-scan-button";

interface FindingRow {
  id: string;
  port: number;
  service: string | null;
  severity: "low" | "medium" | "high";
  state: "open" | "acknowledged" | "baseline" | "muted";
  first_seen_at: string;
}

interface ScanRow {
  id: string;
  host: string;
  status: "queued" | "running" | "done" | "failed";
  open_ports: number[] | null;
  created_at: string;
  completed_at: string | null;
}

const SEV_COLOR: Record<FindingRow["severity"], string> = {
  high: "var(--color-fail)",
  medium: "var(--color-warn)",
  low: "var(--color-muted)",
};

function fmt(ts: string): string {
  return new Date(ts).toLocaleString();
}

export default async function ProjectSecurityPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: project } = await supabase
    .from("projects")
    .select("id, url")
    .eq("id", id)
    .maybeSingle();
  if (!project) notFound();

  let host = project.url;
  try {
    host = new URL(project.url).host;
  } catch {
    /* keep raw url */
  }

  // Both queries degrade to [] if the migration isn't applied yet.
  const { data: findingsData } = await supabase
    .from("port_findings")
    .select("id, port, service, severity, state, first_seen_at")
    .eq("project_id", id)
    .neq("state", "muted")
    .order("severity", { ascending: false });
  const openFindings = (findingsData ?? []).filter(
    (f: FindingRow) => f.state === "open",
  );

  const { data: scansData } = await supabase
    .from("port_scans")
    .select("id, host, status, open_ports, created_at, completed_at")
    .eq("project_id", id)
    .order("created_at", { ascending: false })
    .limit(10);
  const scans = (scansData ?? []) as ScanRow[];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Exposed Services</h2>
          <p className="max-w-2xl text-sm text-[var(--color-muted)]">
            Detects ports open to the public internet on{" "}
            <span className="font-mono">{host}</span> that aren&apos;t in your
            accepted baseline — e.g. a database or cache accidentally exposed.
            Scans run only against your own verified host.
          </p>
        </div>
        <RequestScanButton projectId={id} />
      </div>

      {/* Open findings */}
      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold text-[var(--color-muted)]">
          Open findings
        </h3>
        {openFindings.length === 0 ? (
          <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] p-6 text-sm text-[var(--color-muted)]">
            No open findings. Run a scan to establish a baseline of the ports
            that are currently open, then we&apos;ll alert you when a{" "}
            <em>new</em> one appears.
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            {openFindings.map((f: FindingRow) => (
              <li
                key={f.id}
                className="flex items-center justify-between rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] px-4 py-3"
              >
                <div className="flex items-center gap-3">
                  <span
                    className="rounded px-2 py-0.5 text-xs font-semibold uppercase"
                    style={{ color: SEV_COLOR[f.severity] }}
                  >
                    {f.severity}
                  </span>
                  <span className="font-mono text-sm">
                    {host}:{f.port}
                    {f.service ? (
                      <span className="text-[var(--color-muted)]">
                        {" "}
                        ({f.service})
                      </span>
                    ) : null}
                  </span>
                </div>
                <span className="text-xs text-[var(--color-muted)]">
                  first seen {fmt(f.first_seen_at)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Scan history */}
      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold text-[var(--color-muted)]">
          Recent scans
        </h3>
        {scans.length === 0 ? (
          <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] p-6 text-sm text-[var(--color-muted)]">
            No scans yet.
          </div>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-[var(--color-border)]">
            <table className="w-full text-sm">
              <thead className="bg-[var(--color-card)] text-left text-[var(--color-muted)]">
                <tr>
                  <th className="px-4 py-2 font-medium">Requested</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 font-medium">Open ports</th>
                </tr>
              </thead>
              <tbody>
                {scans.map((s) => (
                  <tr
                    key={s.id}
                    className="border-t border-[var(--color-border)]"
                  >
                    <td className="px-4 py-2">{fmt(s.created_at)}</td>
                    <td className="px-4 py-2">{s.status}</td>
                    <td className="px-4 py-2 font-mono">
                      {s.open_ports && s.open_ports.length > 0
                        ? s.open_ports.join(", ")
                        : s.status === "done"
                          ? "none"
                          : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
