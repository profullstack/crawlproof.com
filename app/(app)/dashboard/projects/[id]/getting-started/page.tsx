import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ProjectShell } from "@/components/project-shell";
import { DEFAULT_PROJECT_ENGINES, type Engine } from "@/lib/credits";
import type { ProjectStatus } from "@/app/actions/projects";

export const metadata = {
  title: "Getting Started",
  description: "Set up CrawlProof for this project step by step.",
};

interface ChecklistStep {
  id: string;
  title: string;
  body: string;
  done: boolean;
  cta: { href: string; label: string };
  docHref?: string;
}

export default async function GettingStartedPage({
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

  // 1. First scan complete.
  const { count: completedAudits } = await supabase
    .from("audits")
    .select("id", { count: "exact", head: true })
    .eq("project_id", id)
    .eq("status", "complete");
  const hasFirstScan = (completedAudits ?? 0) > 0;

  // 2. Stats tracker enabled.
  const trackerEnabled = !!(project as { tracker_enabled?: boolean })
    .tracker_enabled;

  // 3. Autoblog webhook configured (lx_site.webhook_url non-null).
  const { data: lxSite } = await supabase
    .from("lx_site")
    .select("webhook_url")
    .eq("project_id", id)
    .maybeSingle();
  const autoblogConfigured = !!(lxSite as { webhook_url?: string | null } | null)
    ?.webhook_url;

  // 4. AEO Score trend (≥ 2 scored runs).
  const { count: scoredRuns } = await supabase
    .from("project_scores")
    .select("project_id", { count: "exact", head: true })
    .eq("project_id", id);
  const hasTrend = (scoredRuns ?? 0) >= 2;

  const steps: ChecklistStep[] = [
    {
      id: "first-scan",
      title: "Run your first scan",
      body: "Scan your site with one or more AI engines to produce your first audit. Each engine reports what it can find — content, schema, robots, AI-bot rules — and gives you concrete fixes.",
      done: hasFirstScan,
      cta: hasFirstScan
        ? { href: `/dashboard/projects/${id}/scans`, label: "View scans" }
        : { href: `/dashboard/projects/${id}`, label: "Run a scan" },
    },
    {
      id: "stats-tracker",
      title: "Enable the stats tracker",
      body: "Add one <script> tag to your site to see which AI engines refer your visitors and which AI crawlers hit your pages. No cookies, no PII.",
      done: trackerEnabled,
      cta: { href: `/dashboard/projects/${id}/stats`, label: trackerEnabled ? "Open Stats tab" : "Enable tracker" },
      docHref: "/docs/stats-tracker",
    },
    {
      id: "autoblog-webhook",
      title: "Connect the Autoblog webhook",
      body: "Point Autoblog at your CMS or static-site repo and CrawlProof will deliver one SEO post per scheduled slot. CloudEvents 1.0 + Standard Webhooks signing. The @profullstack/autoblog SDK is a 30-LOC drop-in receiver.",
      done: autoblogConfigured,
      cta: {
        href: `/dashboard/projects/${id}/autoblog`,
        label: autoblogConfigured ? "Open Autoblog" : "Configure webhook",
      },
      docHref: "/docs/autoblog-webhook",
    },
    {
      id: "aeo-score-trend",
      title: "Watch your AEO Score climb",
      body: "After two or more scan runs, your AEO Score line chart on the Overview tab shows whether your fixes are moving the number. Schedule weekly scans so you build a useful history.",
      done: hasTrend,
      cta: {
        href: `/dashboard/projects/${id}`,
        label: hasTrend ? "View trend" : "Open Overview",
      },
      docHref: "/docs/aeo-score",
    },
  ];

  const doneCount = steps.filter((s) => s.done).length;
  const total = steps.length;

  return (
    <ProjectShell
      project={{
        id: project.id,
        name: project.name,
        url: project.url,
        schedule: project.schedule,
        status: (project.status ?? "active") as ProjectStatus,
        engines: (project.engines ?? DEFAULT_PROJECT_ENGINES) as Engine[],
        logo_url: (project as { logo_url?: string | null }).logo_url ?? null,
      }}
      currentTab="getting-started"
    >
      <div className="space-y-6">
        <section className="card p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div>
              <h2 className="text-lg font-semibold">Setup checklist</h2>
              <p className="text-sm text-[var(--color-muted)]">
                Walk through these once per project to get the most out of
                CrawlProof. Steps auto-check as you complete them.
              </p>
            </div>
            <p className="text-sm font-medium">
              {doneCount} / {total} done
            </p>
          </div>
        </section>

        <ol className="space-y-3">
          {steps.map((step, i) => (
            <li
              key={step.id}
              className="card flex flex-col gap-3 p-4 sm:flex-row sm:items-start"
            >
              <div
                className={`flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full text-sm font-bold ${
                  step.done
                    ? "bg-green-500/15 text-green-600"
                    : "bg-[var(--color-bg)] text-[var(--color-muted)] border border-[var(--color-border)]"
                }`}
                aria-hidden
              >
                {step.done ? "✓" : i + 1}
              </div>
              <div className="flex-1">
                <h3
                  className={`text-base font-semibold ${
                    step.done ? "text-[var(--color-muted)] line-through" : ""
                  }`}
                >
                  {step.title}
                </h3>
                <p className="mt-1 text-sm text-[var(--color-muted)]">
                  {step.body}
                </p>
                <div className="mt-3 flex flex-wrap items-center gap-3">
                  <Link
                    href={step.cta.href}
                    className={`btn ${step.done ? "btn-secondary" : "btn-primary"} text-sm`}
                  >
                    {step.cta.label}
                  </Link>
                  {step.docHref && (
                    <Link
                      href={step.docHref}
                      className="text-sm underline text-[var(--color-muted)] hover:text-[var(--color-foreground)]"
                    >
                      Read the docs →
                    </Link>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ol>

        <section className="card p-4">
          <h2 className="text-lg font-semibold">More docs</h2>
          <p className="mt-2 text-sm text-[var(--color-muted)]">
            All developer guides live at{" "}
            <Link href="/docs" className="underline">
              /docs
            </Link>
            . Stuck?{" "}
            <a className="underline" href="mailto:hello@crawlproof.com">
              hello@crawlproof.com
            </a>
            .
          </p>
        </section>
      </div>
    </ProjectShell>
  );
}
