import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getProjectById } from "@/lib/lx/currentSite";
import { WEBHOOK_EVENT_TYPES } from "@/lib/webhooks/hub";
import { WebhookManager } from "./manager";

export const metadata = { title: "Autoblog · Webhooks" };

export default async function AutoblogWebhooksPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: projectId } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const project = await getProjectById(projectId, {
    siteColumns: "id, domain, webhook_endpoint_id",
    projectColumns: "id, name, url",
  });
  if (!project) notFound();
  const site = project.lx_site as { id: string; domain: string; webhook_endpoint_id: string | null } | null;
  if (!site) redirect(`/dashboard/projects/${projectId}/autoblog/setup`);

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <Link href={`/dashboard/projects/${projectId}/autoblog`} className="text-sm text-[var(--color-muted)]">
          ← Autoblog
        </Link>
        <h1 className="mt-2 text-3xl font-bold">Webhooks</h1>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          {site.domain} · every endpoint here gets each published post as a signed CloudEvent
          (Standard Webhooks headers plus <code>Authorization: Bearer &lt;secret&gt;</code>), retried
          at +10s and +60s. The one from <Link className="underline" href={`/dashboard/projects/${projectId}/autoblog/setup`}>setup</Link>{" "}
          is marked <em>autoblog</em>. Same API: <code>/api/v1/webhooks?site={site.domain}</code>,{" "}
          <code>crawlproof webhooks</code>, MCP <code>webhook_*</code> tools. See the{" "}
          <Link className="underline" href="/docs/autoblog-webhook">webhook docs</Link>.
        </p>
      </div>
      <WebhookManager siteId={site.id} primaryId={site.webhook_endpoint_id} eventTypes={[...WEBHOOK_EVENT_TYPES]} />
    </div>
  );
}
