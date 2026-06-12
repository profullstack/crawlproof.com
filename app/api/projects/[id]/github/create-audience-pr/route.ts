// POST /api/projects/[id]/github/create-audience-pr
// Body: { owner, repo, installation_id, root_path?, install_mode? }
// Opens the Audience Hub installation PR (stats.js + server helper + env
// docs) on the chosen repo. Owner-initiated only — never runs silently.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { serviceClient } from "@/lib/supabase/service";
import { requireProjectAccess } from "@/lib/lx/currentSite";
import { getOrMintInstallationToken } from "@/lib/github/installations";
import { installAudienceHub } from "@/lib/github/install-audience";

export const runtime = "nodejs";

const bodySchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  installation_id: z.number().int().positive(),
  root_path: z.string().max(500).optional(),
  install_mode: z
    .enum(["browser_only", "server_only", "browser_and_server"])
    .optional(),
  default_branch: z.string().max(200).optional(),
});

export async function POST(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: projectId } = await ctx.params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body;
  try {
    body = bodySchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }

  const projectAccess = await requireProjectAccess(projectId);
  if (!projectAccess.ok) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (projectAccess.isViewer) {
    return NextResponse.json({ error: "Viewers can't open PRs" }, { status: 403 });
  }

  const { data: installation } = await supabase
    .from("github_installations")
    .select("installation_id")
    .eq("installation_id", body.installation_id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!installation) {
    return NextResponse.json(
      { error: "Installation not connected to this account" },
      { status: 403 },
    );
  }

  const svc = serviceClient();
  const { data: project } = await svc
    .from("projects")
    .select("id, url")
    .eq("id", projectId)
    .maybeSingle();
  const projectDomain = domainFromUrl(project?.url as string | undefined);

  // Audit-log the run (PRD §13: all GitHub write actions are logged).
  const { data: run } = await svc
    .from("project_pr_runs")
    .insert({
      project_id: projectId,
      owner_id: user.id,
      kind: "audience_hub",
      installation_id: body.installation_id,
      repo_owner: body.owner,
      repo_name: body.repo,
      status: "running",
    })
    .select("id")
    .single();
  const runId = run?.id as string | undefined;

  async function finalize(patch: Record<string, unknown>) {
    if (!runId) return;
    await svc
      .from("project_pr_runs")
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq("id", runId);
  }

  try {
    const token = await getOrMintInstallationToken(body.installation_id);
    const result = await installAudienceHub({
      token,
      owner: body.owner,
      repo: body.repo,
      projectId,
      projectDomain,
      rootPath: body.root_path,
      installMode: body.install_mode,
    });
    await finalize({
      status: result.status,
      pr_url: result.prUrl ?? null,
      pr_number: result.prNumber ?? null,
      branch_name: result.branch ?? null,
    });
    await svc.from("project_repos").upsert(
      {
        project_id: projectId,
        installation_id: body.installation_id,
        repo_owner: body.owner,
        repo_name: body.repo,
        default_branch: body.default_branch ?? null,
        added_by: user.id,
      },
      { onConflict: "project_id,repo_owner,repo_name" },
    );
    return NextResponse.json({ data: result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await finalize({ status: "failed", error: msg });
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

function domainFromUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}
