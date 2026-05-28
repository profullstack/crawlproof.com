// Per-project Stats → Webhooks sub-tab. Lists registered webhook URLs
// and exposes CRUD + Test/Rotate-secret per row. Each enabled webhook
// receives a Standard-Webhooks-signed copy of every tracker event for
// the project (fan-out lives in app/api/track/route.ts).

import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ProjectShell } from "@/components/project-shell";
import type { Engine } from "@/lib/credits";
import type { ProjectStatus } from "@/app/actions/projects";
import { StatsSubnav } from "../stats-subnav";
import { AddWebhookModal } from "./add-webhook-modal";
import { WebhookRow, type WebhookRowData } from "./webhook-row";

export const metadata = { title: "Stats webhooks" };

export default async function StatsWebhooksPage({
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

  const { data: webhookData } = await supabase
    .from("tracker_webhooks")
    .select(
      "id, url, description, enabled, last_delivery_at, last_response_code, last_error, created_at",
    )
    .eq("project_id", id)
    .order("created_at", { ascending: false });
  const webhooks = (webhookData ?? []) as WebhookRowData[];

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
        <StatsSubnav projectId={id} active="webhooks" />

        <section className="card p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div>
              <h2 className="text-lg font-semibold">Tracker webhooks</h2>
              <p className="text-sm text-[var(--color-muted)]">
                Forward every tracker event for this project to one or more
                URLs. Each request is signed with HMAC-SHA256 and includes a
                bearer token so receivers can verify either way.
              </p>
            </div>
            <AddWebhookModal projectId={id} />
          </div>

          {webhooks.length === 0 ? (
            <p className="mt-4 text-sm text-[var(--color-muted)]">
              No webhooks yet. Add one to start receiving raw events on your
              own infrastructure.
            </p>
          ) : (
            <ul className="mt-4 divide-y divide-[var(--color-border)] rounded-md border border-[var(--color-border)]">
              {webhooks.map((w) => (
                <WebhookRow key={w.id} projectId={id} row={w} />
              ))}
            </ul>
          )}
        </section>

        <section className="card p-4">
          <h2 className="text-lg font-semibold">Delivery format</h2>
          <p className="mt-1 text-sm text-[var(--color-muted)]">
            Each event is delivered as JSON via <code>POST</code> with the
            following headers:
          </p>
          <ul className="mt-2 list-disc pl-5 text-sm leading-relaxed">
            <li>
              <code>webhook-id</code> — unique per event (use for dedupe).
            </li>
            <li>
              <code>webhook-timestamp</code> — unix seconds.
            </li>
            <li>
              <code>webhook-signature</code> —{" "}
              <code>v1,&lt;base64 HMAC-SHA256&gt;</code> over{" "}
              <code>{`{id}.{timestamp}.{body}`}</code> with your secret.
            </li>
            <li>
              <code>authorization</code> — <code>Bearer &lt;secret&gt;</code>{" "}
              (parallel check, optional to verify).
            </li>
          </ul>
          <p className="mt-3 text-sm text-[var(--color-muted)]">
            Body shape: <code>{`{id, type, project_id, occurred_at, data}`}</code>{" "}
            where <code>type</code> is <code>tracker.event</code> for real
            traffic or <code>tracker.test</code> for the Test button.
          </p>
        </section>
      </div>
    </ProjectShell>
  );
}
