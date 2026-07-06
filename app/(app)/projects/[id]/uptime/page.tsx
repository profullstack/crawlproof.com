// Per-project "Uptime" tab (uptime-monitoring-prd.md §3–§7). Lists monitors
// with their current up/down state and recent incidents; the worker runs the
// actual checks and sends down/recovery alerts. Degrades to empty states if the
// migration isn't applied yet.
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { AddMonitorForm } from "./add-monitor-form";
import { MonitorActions } from "./monitor-actions";

interface MonitorRow {
  id: string;
  name: string;
  type: string;
  target: string;
  enabled: boolean;
  current_state: "up" | "down" | "unknown";
  last_checked_at: string | null;
  last_error: string | null;
  last_response_ms: number | null;
}

interface IncidentRow {
  id: string;
  monitor_id: string;
  started_at: string;
  ended_at: string | null;
  cause: string | null;
  duration_s: number | null;
}

const STATE_COLOR: Record<MonitorRow["current_state"], string> = {
  up: "var(--color-pass)",
  down: "var(--color-fail)",
  unknown: "var(--color-muted)",
};
const STATE_LABEL: Record<MonitorRow["current_state"], string> = {
  up: "Up",
  down: "Down",
  unknown: "Pending",
};

function fmt(ts: string | null): string {
  return ts ? new Date(ts).toLocaleString() : "—";
}
function dur(s: number | null): string {
  if (s == null) return "—";
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${(s / 3600).toFixed(1)}h`;
}

export default async function ProjectUptimePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: project } = await supabase
    .from("projects")
    .select("id")
    .eq("id", id)
    .maybeSingle();
  if (!project) notFound();

  const { data: monitorsData } = await supabase
    .from("monitors")
    .select(
      "id, name, type, target, enabled, current_state, last_checked_at, last_error, last_response_ms",
    )
    .eq("project_id", id)
    .order("created_at", { ascending: true });
  const monitors = (monitorsData ?? []) as MonitorRow[];

  const { data: incidentsData } = await supabase
    .from("monitor_incidents")
    .select("id, monitor_id, started_at, ended_at, cause, duration_s")
    .eq("project_id", id)
    .order("started_at", { ascending: false })
    .limit(15);
  const incidents = (incidentsData ?? []) as IncidentRow[];
  const nameOf = new Map(monitors.map((m) => [m.id, m.name]));

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Uptime Monitors</h2>
          <p className="max-w-2xl text-sm text-[var(--color-muted)]">
            We check each target on its interval and email you the moment it goes
            down — and again when it recovers. HTTP, keyword, SSL-expiry, and TCP.
          </p>
        </div>
        <AddMonitorForm projectId={id} />
      </div>

      {/* Monitors */}
      {monitors.length === 0 ? (
        <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] p-6 text-sm text-[var(--color-muted)]">
          No monitors yet. Add one to start watching a URL, host, or port.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-[var(--color-border)]">
          <table className="w-full text-sm">
            <thead className="bg-[var(--color-card)] text-left text-[var(--color-muted)]">
              <tr>
                <th className="px-4 py-2 font-medium">State</th>
                <th className="px-4 py-2 font-medium">Monitor</th>
                <th className="px-4 py-2 font-medium">Last check</th>
                <th className="px-4 py-2 font-medium">Latency</th>
                <th className="px-4 py-2 font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {monitors.map((m) => (
                <tr key={m.id} className="border-t border-[var(--color-border)]">
                  <td className="px-4 py-2">
                    <span
                      className="font-semibold"
                      style={{ color: STATE_COLOR[m.current_state] }}
                    >
                      ● {STATE_LABEL[m.current_state]}
                    </span>
                    {!m.enabled && (
                      <span className="ml-1 text-xs text-[var(--color-muted)]">(paused)</span>
                    )}
                  </td>
                  <td className="px-4 py-2">
                    <div className="font-medium">{m.name}</div>
                    <div className="font-mono text-xs text-[var(--color-muted)]">
                      {m.type} · {m.target}
                    </div>
                    {m.current_state === "down" && m.last_error && (
                      <div className="text-xs text-[var(--color-fail)]">{m.last_error}</div>
                    )}
                  </td>
                  <td className="px-4 py-2 text-[var(--color-muted)]">{fmt(m.last_checked_at)}</td>
                  <td className="px-4 py-2 text-[var(--color-muted)]">
                    {m.last_response_ms != null ? `${m.last_response_ms} ms` : "—"}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <MonitorActions
                      projectId={id}
                      monitorId={m.id}
                      enabled={m.enabled}
                      name={m.name}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Incidents */}
      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold text-[var(--color-muted)]">Recent incidents</h3>
        {incidents.length === 0 ? (
          <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] p-6 text-sm text-[var(--color-muted)]">
            No incidents. 🎉
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            {incidents.map((i) => (
              <li
                key={i.id}
                className="flex items-center justify-between rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] px-4 py-3 text-sm"
              >
                <div>
                  <span className="font-medium">{nameOf.get(i.monitor_id) ?? "monitor"}</span>
                  <span className="ml-2 text-xs text-[var(--color-muted)]">{i.cause}</span>
                </div>
                <div className="text-right text-xs text-[var(--color-muted)]">
                  <div>{fmt(i.started_at)}</div>
                  <div>
                    {i.ended_at ? `resolved · down ${dur(i.duration_s)}` : "ongoing"}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
