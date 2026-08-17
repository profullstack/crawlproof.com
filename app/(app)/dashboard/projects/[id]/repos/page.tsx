// Per-project "Repos" tab. Lets the user bind one or more GitHub repos
// to a project so the Install Tracker + Apply Fix actions can default to
// them instead of showing the full 200+ repo list every time.

import { notFound } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { ProjectShell } from "@/components/project-shell";
import { env } from "@/lib/env";
import {
  getOrMintInstallationToken,
} from "@/lib/github/installations";
import { listInstallationRepos } from "@/lib/github/app";
import { DEFAULT_PROJECT_ENGINES, type Engine } from "@/lib/credits";
import type { ProjectStatus } from "@/app/actions/projects";
import { AddRepoModal } from "./add-repo-modal";
import { RemoveButton } from "./remove-button";

interface BoundRepoRow {
  id: string;
  installation_id: number;
  repo_owner: string;
  repo_name: string;
  default_branch: string | null;
  added_at: string;
}

export default async function ProjectReposPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data: project } = await supabase
    .from("projects")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (!project) notFound();

  const ghConfigured = !!(env.githubAppId && env.githubAppPrivateKey);

  // Bound repos for this project (RLS scopes to the project owner).
  const { data: boundData } = await supabase
    .from("project_repos")
    .select(
      "id, installation_id, repo_owner, repo_name, default_branch, added_at",
    )
    .eq("project_id", id)
    .order("added_at", { ascending: false });
  const bound = (boundData ?? []) as BoundRepoRow[];

  // Available repos across all the user's installations. Pulled live so
  // adding/removing repos on github.com is reflected immediately.
  type Available = {
    full_name: string;
    installation_id: number;
    default_branch: string;
    private: boolean;
    account: string;
  };
  const available: Available[] = [];
  if (ghConfigured && user) {
    const { data: installs } = await supabase
      .from("github_installations")
      .select("installation_id, account_login")
      .is("removed_at", null);
    for (const i of (installs ?? []) as Array<{
      installation_id: number;
      account_login: string;
    }>) {
      try {
        const token = await getOrMintInstallationToken(i.installation_id);
        const repos = await listInstallationRepos(token);
        for (const r of repos) {
          available.push({
            full_name: r.full_name,
            installation_id: i.installation_id,
            default_branch: r.default_branch,
            private: r.private,
            account: i.account_login,
          });
        }
      } catch {
        // Skip on auth error; settings page will show details.
      }
    }
  }

  const alreadyBound = bound.map((b) => `${b.repo_owner}/${b.repo_name}`);

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
      currentTab="repos"
    >
      <div className="space-y-6">
        <section className="card p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div>
              <h2 className="text-lg font-semibold">Bound repos</h2>
              <p className="text-sm text-[var(--color-muted)]">
                Repos in this list show up first in the Install Tracker and
                Apply Fix modals. Optional — leave it empty to pick from
                all repos every time.
              </p>
            </div>
            {ghConfigured && (
              <AddRepoModal
                projectId={id}
                available={available}
                alreadyBound={alreadyBound}
              />
            )}
          </div>

          {!ghConfigured ? (
            <p className="mt-4 text-sm">
              The GitHub integration isn&apos;t configured on this
              deployment yet.{" "}
              <Link
                href="/dashboard/settings/integrations/github"
                className="underline"
              >
                Set it up →
              </Link>
            </p>
          ) : available.length === 0 ? (
            <p className="mt-4 text-sm">
              You haven&apos;t connected a GitHub installation yet.{" "}
              <Link
                href="/dashboard/settings/integrations/github"
                className="underline"
              >
                Connect on the GitHub settings page →
              </Link>
            </p>
          ) : bound.length === 0 ? (
            <p className="mt-4 text-sm text-[var(--color-muted)]">
              No repos bound yet. Click <strong>Add repo</strong> to pick
              one from your {available.length} available repos.
            </p>
          ) : (
            <ul className="mt-4 divide-y divide-[var(--color-border)] rounded-md border border-[var(--color-border)]">
              {bound.map((b) => (
                <li
                  key={b.id}
                  className="flex flex-wrap items-center justify-between gap-3 p-3"
                >
                  <div>
                    <p className="text-sm font-medium">
                      {b.repo_owner}/{b.repo_name}
                    </p>
                    <p className="text-xs text-[var(--color-muted)]">
                      {b.default_branch ?? "default branch"} · added{" "}
                      {new Date(b.added_at).toLocaleDateString()}
                    </p>
                  </div>
                  <RemoveButton
                    projectId={id}
                    repoId={b.id}
                    repoFullName={`${b.repo_owner}/${b.repo_name}`}
                  />
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="card p-4">
          <h2 className="text-lg font-semibold">What bound repos do</h2>
          <ul className="mt-2 list-disc pl-5 text-sm leading-relaxed">
            <li>
              <strong>Install Tracker</strong> (Stats tab) opens a PR to add
              our stats.js snippet to a repo of your choice. Bound repos
              are pre-selected.
            </li>
            <li>
              <strong>Apply Fix</strong> (audit findings) opens a Claude-
              authored PR that patches one specific check. Costs 20 credits
              (~$1) per run; refunded on failure.
            </li>
            <li>
              <strong>Future:</strong> webhook-triggered audits on push to
              bound repos; automated llms.txt updates on releases.
            </li>
          </ul>
        </section>
      </div>
    </ProjectShell>
  );
}
