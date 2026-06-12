import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { env } from "@/lib/env";
import { AudienceKeysClient, CreateAudiencePrClient } from "./client";

export const metadata = { title: "Project · Audience" };

// Project integration page for the Audience Hub (PRD §15): install status,
// snippets, server ingest keys, and the owner-initiated Create PR flow.

type KeyRow = {
  id: string;
  name: string;
  key_prefix: string;
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
};

type RepoRow = {
  installation_id: number;
  repo_owner: string;
  repo_name: string;
  default_branch: string | null;
  root_path?: string | null;
};

type RunRow = {
  id: string;
  status: string;
  pr_url: string | null;
  repo_owner: string;
  repo_name: string;
  created_at: string;
};

function fmt(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export default async function ProjectAudiencePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: projectId } = await params;
  const supabase = await createClient();
  const { data: project } = await supabase
    .from("projects")
    .select("id, name, url, tracker_enabled")
    .eq("id", projectId)
    .maybeSingle();
  if (!project) notFound();

  const siteUrl = env.siteUrl.replace(/\/$/, "");

  const [keysRes, reposRes, runsRes, lastBrowserRes, lastServerRes, contactCountRes] =
    await Promise.all([
      supabase
        .from("project_api_keys")
        .select("id, name, key_prefix, last_used_at, revoked_at, created_at")
        .eq("project_id", projectId)
        .order("created_at", { ascending: false }),
      supabase
        .from("project_repos")
        .select("installation_id, repo_owner, repo_name, default_branch")
        .eq("project_id", projectId),
      supabase
        .from("project_pr_runs")
        .select("id, status, pr_url, repo_owner, repo_name, created_at")
        .eq("project_id", projectId)
        .eq("kind", "audience_hub")
        .order("created_at", { ascending: false })
        .limit(5),
      supabase
        .from("audience_events")
        .select("occurred_at")
        .eq("project_id", projectId)
        .eq("source", "browser")
        .order("occurred_at", { ascending: false })
        .limit(1),
      supabase
        .from("audience_events")
        .select("occurred_at")
        .eq("project_id", projectId)
        .eq("source", "server")
        .order("occurred_at", { ascending: false })
        .limit(1),
      supabase
        .from("audience_project_links")
        .select("id", { count: "exact", head: true })
        .eq("project_id", projectId),
    ]);

  const keys = (keysRes.data ?? []) as KeyRow[];
  const repos = (reposRes.data ?? []) as RepoRow[];
  const runs = (runsRes.data ?? []) as RunRow[];
  const lastBrowser = (lastBrowserRes.data?.[0]?.occurred_at as string | undefined) ?? null;
  const lastServer = (lastServerRes.data?.[0]?.occurred_at as string | undefined) ?? null;
  const contactCount = contactCountRes.count ?? 0;

  const scriptSnippet = `<script data-site="${projectId}" src="${siteUrl}/stats.js" async></script>`;
  const identifySnippet = `window.crawlproof("identify", {
  email: user.email,
  name: user.name,
  user_id: user.id,
  marketing_consent: Boolean(user.marketingConsent)
});`;
  const curlSnippet = `curl -X POST ${siteUrl}/api/events \\
  -H "Authorization: Bearer $CRAWLPROOF_PROJECT_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"event":"user.created","email":"user@example.com","marketing_consent":true}'`;

  const statusCards: { label: string; value: string; ok: boolean }[] = [
    {
      label: "stats.js tracker",
      value: project.tracker_enabled ? "enabled" : "disabled",
      ok: !!project.tracker_enabled,
    },
    {
      label: "Last browser event",
      value: fmt(lastBrowser),
      ok: !!lastBrowser,
    },
    {
      label: "Last server event",
      value: fmt(lastServer),
      ok: !!lastServer,
    },
    {
      label: "Contacts from this project",
      value: String(contactCount),
      ok: contactCount > 0,
    },
  ];

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">Audience Hub</h2>
          <p className="mt-1 max-w-2xl text-sm text-[var(--color-muted)]">
            Capture leads, signups and customers from this property into your
            central audience. Browser events ride the existing{" "}
            <code>stats.js</code> install; trusted lifecycle events use a
            server API key.
          </p>
        </div>
        <Link href="/audience" className="btn">
          View all contacts →
        </Link>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {statusCards.map((card) => (
          <div key={card.label} className="card p-4">
            <div className={`text-sm font-semibold ${card.ok ? "" : "text-[var(--color-muted)]"}`}>
              {card.value}
            </div>
            <div className="mt-1 text-xs uppercase tracking-wider text-[var(--color-muted)]">
              {card.label}
            </div>
          </div>
        ))}
      </div>

      <section className="card p-5">
        <h3 className="text-lg font-semibold">Install via GitHub PR</h3>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          CrawlProof opens a small, reviewable pull request: the{" "}
          <code>stats.js</code> snippet, a generated server helper for{" "}
          <code>/api/events</code> where the stack supports it, and{" "}
          <code>.env.example</code> docs. Nothing is pushed to your default
          branch — you review and merge.
        </p>
        <div className="mt-4">
          <CreateAudiencePrClient projectId={projectId} repos={repos} />
        </div>
        {runs.length > 0 && (
          <ul className="mt-4 space-y-1.5 border-t border-[var(--color-border)] pt-3 text-sm">
            {runs.map((run) => (
              <li key={run.id} className="flex flex-wrap items-center gap-2">
                <span
                  className={`badge ${
                    run.status === "opened"
                      ? "badge-pass"
                      : run.status === "failed"
                        ? "badge-fail"
                        : "badge-warn"
                  }`}
                >
                  {run.status}
                </span>
                <span>
                  {run.repo_owner}/{run.repo_name}
                </span>
                {run.pr_url && (
                  <a href={run.pr_url} target="_blank" rel="noreferrer" className="underline">
                    {run.pr_url.replace("https://github.com/", "")}
                  </a>
                )}
                <span className="text-xs text-[var(--color-muted)]">{fmt(run.created_at)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card p-5">
        <h3 className="text-lg font-semibold">Server API keys</h3>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          Authenticate <code>POST {siteUrl}/api/events</code> with{" "}
          <code>Authorization: Bearer cpk_…</code>. Keys are hashed at rest and
          shown once at mint time.
        </p>
        <div className="mt-4">
          <AudienceKeysClient projectId={projectId} keys={keys} />
        </div>
      </section>

      <section className="card p-5">
        <h3 className="text-lg font-semibold">Manual install</h3>
        <div className="mt-3 space-y-4 text-sm">
          <div>
            <p className="font-medium">1. Tracker snippet (before <code>&lt;/body&gt;</code>)</p>
            <pre className="mt-2 overflow-x-auto rounded bg-[var(--color-bg)] p-3 text-xs">
              <code>{scriptSnippet}</code>
            </pre>
          </div>
          <div>
            <p className="font-medium">2. Identify logged-in users / capture leads</p>
            <pre className="mt-2 overflow-x-auto rounded bg-[var(--color-bg)] p-3 text-xs">
              <code>{identifySnippet}</code>
            </pre>
            <p className="mt-2 text-[var(--color-muted)]">
              Also available: <code>window.crawlproof(&quot;track&quot;, &quot;lead.captured&quot;, {"{ email, source }"})</code>,{" "}
              <code>window.crawlproof(&quot;consent&quot;, {"{ email, marketing_consent: true }"})</code>.
            </p>
          </div>
          <div>
            <p className="font-medium">3. Trusted server events</p>
            <pre className="mt-2 overflow-x-auto rounded bg-[var(--color-bg)] p-3 text-xs">
              <code>{curlSnippet}</code>
            </pre>
          </div>
        </div>
      </section>
    </div>
  );
}
