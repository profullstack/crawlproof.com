// Repos a project can open a PR against, for the dashboard's install buttons.
//
// Best-effort throughout: if the GitHub App isn't configured, or an
// installation's listing fails, the caller gets fewer options rather than an
// error page. The install button simply doesn't appear.

import { env } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";
import { getOrMintInstallationToken } from "@/lib/github/installations";
import { listInstallationRepos } from "@/lib/github/app";

export interface RepoOption {
  full_name: string;
  installation_id: number;
  default_branch?: string | null;
  /** Already attached to this project — worth showing first. */
  bound?: boolean;
}

export interface RepoOptions {
  /** False when the GitHub App isn't set up for this deployment. */
  configured: boolean;
  repos: RepoOption[];
}

export async function loadRepoOptions(projectId: string): Promise<RepoOptions> {
  const configured = !!(env.githubAppId && env.githubAppPrivateKey);
  if (!configured) return { configured: false, repos: [] };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { configured: true, repos: [] };

  const { data: installRows } = await supabase
    .from("github_installations")
    .select("installation_id")
    .is("removed_at", null);

  const { data: boundRows } = await supabase
    .from("project_repos")
    .select("repo_owner, repo_name")
    .eq("project_id", projectId);
  const bound = new Set(
    ((boundRows ?? []) as Array<{ repo_owner: string; repo_name: string }>).map(
      (r) => `${r.repo_owner}/${r.repo_name}`,
    ),
  );

  const repos: RepoOption[] = [];
  for (const row of (installRows ?? []) as Array<{ installation_id: number }>) {
    try {
      const token = await getOrMintInstallationToken(row.installation_id);
      for (const repo of await listInstallationRepos(token)) {
        repos.push({
          full_name: repo.full_name,
          installation_id: row.installation_id,
          default_branch: repo.default_branch,
          bound: bound.has(repo.full_name),
        });
      }
    } catch {
      // Skip this installation; the integrations settings page reports why.
    }
  }

  // Connected repos first, then alphabetical — the one they want is usually
  // one they've already attached.
  repos.sort((a, b) => {
    if (a.bound !== b.bound) return a.bound ? -1 : 1;
    return a.full_name.localeCompare(b.full_name);
  });

  return { configured: true, repos };
}
