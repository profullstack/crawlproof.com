import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type { IntegrationAnalysis, IntegrationEndpoint } from "@/lib/tracker/integration-analyzer";
import { StatsSubnav } from "../stats-subnav";
import { DeleteIntegrationButton, IntegrationForm } from "./integration-form";

type IntegrationRow = {
  id: string;
  name: string;
  source_url: string | null;
  status: string;
  http_status: number | null;
  content_type: string | null;
  script_sha256: string | null;
  script_bytes: number;
  analysis: IntegrationAnalysis;
  fetched_at: string | null;
  created_at: string;
};

export default async function StatsIntegrationsPage({
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

  const { data } = await supabase
    .from("tracker_integrations")
    .select(
      "id, name, source_url, status, http_status, content_type, script_sha256, script_bytes, analysis, fetched_at, created_at",
    )
    .eq("project_id", id)
    .order("created_at", { ascending: false });
  const integrations = ((data ?? []) as IntegrationRow[]).map((row) => ({
    ...row,
    analysis: normalizeAnalysis(row.analysis),
  }));

  return (
    <div className="space-y-6">
      <StatsSubnav projectId={id} />

      <IntegrationForm projectId={id} />

      <section className="space-y-3">
        <div>
          <h2 className="text-lg font-semibold">Mapped integrations</h2>
          <p className="text-sm text-[var(--color-muted)]">
            Public tracker APIs normalized into a CrawlProof adapter plan.
          </p>
        </div>

        {integrations.length === 0 ? (
          <div className="card p-4">
            <p className="text-sm text-[var(--color-muted)]">
              No integrations analyzed yet.
            </p>
          </div>
        ) : (
          integrations.map((integration) => (
            <IntegrationCard
              key={integration.id}
              projectId={id}
              integration={integration}
            />
          ))
        )}
      </section>
    </div>
  );
}

function IntegrationCard({
  projectId,
  integration,
}: {
  projectId: string;
  integration: IntegrationRow;
}) {
  const analysis = integration.analysis;
  const sourceUrl = analysis.source.scriptUrl ?? integration.source_url;
  const created = new Date(integration.created_at).toLocaleString();

  return (
    <article className="card space-y-4 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-base font-semibold">{integration.name}</h3>
            <span className="rounded border border-[var(--color-border)] px-2 py-0.5 text-xs text-[var(--color-muted)]">
              {analysis.source.inputType}
            </span>
          </div>
          {sourceUrl ? (
            <a
              href={sourceUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-1 block max-w-full break-all text-sm text-[var(--color-muted)] underline hover:text-[var(--color-fg)]"
            >
              {sourceUrl}
            </a>
          ) : (
            <p className="mt-1 text-sm text-[var(--color-muted)]">Inline snippet</p>
          )}
          <p className="mt-1 text-xs text-[var(--color-muted)]">
            Added {created}
            {analysis.source.httpStatus ? ` | HTTP ${analysis.source.httpStatus}` : ""}
            {analysis.source.fetchedBytes
              ? ` | ${formatBytes(analysis.source.fetchedBytes)}`
              : ""}
          </p>
        </div>
        <DeleteIntegrationButton
          projectId={projectId}
          integrationId={integration.id}
        />
      </div>

      <SummaryList items={analysis.summary} />

      {analysis.warnings.length > 0 && (
        <div className="rounded-md border border-yellow-300 bg-yellow-50 p-3 text-sm text-yellow-900">
          <ul className="list-disc space-y-1 pl-5">
            {analysis.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </div>
      )}

      <EndpointTable endpoints={analysis.endpoints} />

      <div className="grid gap-3 md:grid-cols-2">
        <FactBox title="SDK surface" rows={[
          ["Globals", analysis.globals],
          ["Methods", analysis.methods],
          ["Events", analysis.events],
        ]} />
        <FactBox title="Config" rows={[
          ["Keys", analysis.configKeys],
          ["Public hints", analysis.authHints],
          ["Attributes", Object.entries(analysis.source.attributes).map(([k, v]) => `${k}=${v}`)],
        ]} />
      </div>

      <div className="grid gap-3 lg:grid-cols-3">
        <CodeBlock
          title="SDK"
          code={`import { createCrawlProofClient } from "@crawlproof/sdk";

const analytics = createCrawlProofClient({
  projectId: "${projectId}",
});

analytics.track("pageview", {
  adapter: "${adapterName(integration)}",
});`}
        />
        <CodeBlock
          title="CLI"
          code={`crawlproof stats track \\
  --project ${projectId} \\
  --event pageview \\
  --adapter ${adapterName(integration)}`}
        />
        <CodeBlock
          title="Agent plugin"
          code={`{
  "name": "crawlproof-stats",
  "tools": [{
    "name": "crawlproof.track",
    "projectId": "${projectId}",
    "adapter": "${adapterName(integration)}"
  }]
}`}
        />
      </div>

      {analysis.source.sha256 && (
        <p className="break-all text-xs text-[var(--color-muted)]">
          SHA-256: {analysis.source.sha256}
        </p>
      )}
    </article>
  );
}

function EndpointTable({ endpoints }: { endpoints: IntegrationEndpoint[] }) {
  if (endpoints.length === 0) {
    return (
      <div className="rounded-md border border-[var(--color-border)] p-3">
        <p className="text-sm text-[var(--color-muted)]">
          No public endpoints detected by static analysis.
        </p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-md border border-[var(--color-border)]">
      <table className="w-full min-w-[680px] text-left text-sm">
        <thead className="bg-[var(--color-bg)] text-xs uppercase text-[var(--color-muted)]">
          <tr>
            <th className="px-3 py-2">Method</th>
            <th className="px-3 py-2">Transport</th>
            <th className="px-3 py-2">Host</th>
            <th className="px-3 py-2">Path</th>
          </tr>
        </thead>
        <tbody>
          {endpoints.map((endpoint) => (
            <tr key={`${endpoint.method}:${endpoint.url}`} className="border-t border-[var(--color-border)]">
              <td className="px-3 py-2 font-mono text-xs">{endpoint.method}</td>
              <td className="px-3 py-2">{endpoint.transport}</td>
              <td className="px-3 py-2 break-all">{endpoint.host}</td>
              <td className="px-3 py-2 break-all font-mono text-xs">{endpoint.path}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SummaryList({ items }: { items: string[] }) {
  return (
    <ul className="grid gap-2 text-sm sm:grid-cols-2">
      {items.map((item) => (
        <li
          key={item}
          className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2"
        >
          {item}
        </li>
      ))}
    </ul>
  );
}

function FactBox({
  title,
  rows,
}: {
  title: string;
  rows: Array<[string, string[]]>;
}) {
  return (
    <div className="rounded-md border border-[var(--color-border)] p-3">
      <h4 className="text-sm font-semibold">{title}</h4>
      <dl className="mt-2 space-y-2 text-sm">
        {rows.map(([label, values]) => (
          <div key={label}>
            <dt className="text-xs uppercase text-[var(--color-muted)]">{label}</dt>
            <dd className="mt-1 break-words">
              {values.length ? values.join(", ") : (
                <span className="text-[var(--color-muted)]">None detected</span>
              )}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function CodeBlock({ title, code }: { title: string; code: string }) {
  return (
    <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-3">
      <h4 className="text-sm font-semibold">{title}</h4>
      <pre className="mt-2 overflow-x-auto whitespace-pre-wrap text-xs">
        <code>{code}</code>
      </pre>
    </div>
  );
}

function normalizeAnalysis(value: IntegrationAnalysis | null): IntegrationAnalysis {
  if (value?.source) return value;
  return {
    source: {
      inputType: "raw",
      scriptUrl: null,
      origin: null,
      attributes: {},
      fetchedBytes: 0,
      sha256: null,
      contentType: null,
      httpStatus: null,
    },
    endpoints: [],
    globals: [],
    methods: [],
    configKeys: [],
    events: [],
    authHints: [],
    warnings: [],
    summary: ["Stored pasted input for manual adapter mapping."],
  };
}

function adapterName(integration: IntegrationRow) {
  const base =
    integration.analysis.source.origin
      ? new URL(integration.analysis.source.origin).hostname
      : integration.name;
  return base.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "custom";
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}
