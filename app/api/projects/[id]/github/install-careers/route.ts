// POST /api/projects/[id]/github/install-careers
// Body: { owner, repo, installation_id, root_path?, target_dir?, default_branch?, mode? }
//
// mode=candidates → scan the repo and rank every place a careers route could
//                   go. Read-only, no PR, no run row.
// mode=detect     → report the framework we'd write for at one root, without
//                   touching the repo.
// mode=submit     → open the PR (default). Honours target_dir when the user
//                   picked a location, after re-verifying it server-side.
//
// Auth mirrors install-tracker: a signed-in user, with access to the project,
// using an installation connected to their own account.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { serviceClient } from "@/lib/supabase/service";
import { requireProjectAccess } from "@/lib/lx/currentSite";
import { getOrMintInstallationToken } from "@/lib/github/installations";
import {
  detectFramework,
  findCareersCandidates,
  installCareersPage,
  verifyCareersDir,
} from "@/lib/github/install-careers";
import { getRepo } from "@/lib/github/repos";

export const runtime = "nodejs";

const bodySchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  installation_id: z.number().int().positive(),
  root_path: z.string().max(500).optional(),
  target_dir: z.string().max(500).optional(),
  default_branch: z.string().max(200).optional(),
  mode: z.enum(["candidates", "detect", "submit"]).optional(),
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
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

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

  // The careers module has to be on: a PR pointing at a feed that returns
  // nothing is a confusing thing to receive.
  const { data: project } = await supabase
    .from("projects")
    .select("careers_enabled")
    .eq("id", projectId)
    .maybeSingle();
  if (!project?.careers_enabled) {
    return NextResponse.json(
      { error: "Turn the careers widget on before installing the page." },
      { status: 409 },
    );
  }

  const mode = body.mode ?? "submit";

  // Read-only scan: no PR, no run row.
  if (mode === "candidates") {
    try {
      const token = await getOrMintInstallationToken(body.installation_id);
      const { candidates, truncated } = await findCareersCandidates({
        token,
        owner: body.owner,
        repo: body.repo,
        rootPath: body.root_path,
      });
      return NextResponse.json({ data: { candidates, truncated } });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return NextResponse.json({ error: msg }, { status: 500 });
    }
  }

  if (mode === "detect") {
    try {
      const token = await getOrMintInstallationToken(body.installation_id);
      const repoMeta = await getRepo({ token, owner: body.owner, repo: body.repo });
      const detected = await detectFramework({
        token,
        owner: body.owner,
        repo: body.repo,
        ref: repoMeta.default_branch,
        rootPath: body.root_path,
      });
      return NextResponse.json({ data: { detected } });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return NextResponse.json({ error: msg }, { status: 500 });
    }
  }

  const svc = serviceClient();
  const { data: run } = await (svc as any)
    .from("project_pr_runs")
    .insert({
      project_id: projectId,
      owner_id: user.id,
      kind: "install_careers",
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
    await (svc as any)
      .from("project_pr_runs")
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq("id", runId);
  }

  try {
    const token = await getOrMintInstallationToken(body.installation_id);

    // A directory chosen in the browser is never trusted on its own — re-probe
    // for the framework marker so we still only write where we can see a site.
    let detected;
    if (body.target_dir?.trim()) {
      const repoMeta = await getRepo({ token, owner: body.owner, repo: body.repo });
      detected =
        (await verifyCareersDir({
          token,
          owner: body.owner,
          repo: body.repo,
          ref: repoMeta.default_branch,
          dir: body.target_dir.trim(),
        })) ?? undefined;
      if (!detected) {
        const msg =
          `No Next.js App Router or Astro site at ${body.target_dir.trim()}. ` +
          "Pick one of the scanned locations, or point at the directory holding layout.tsx.";
        await finalize({ status: "failed", error: msg });
        return NextResponse.json({ error: msg }, { status: 422 });
      }
    }

    const result = await installCareersPage({
      token,
      owner: body.owner,
      repo: body.repo,
      projectId,
      rootPath: body.root_path,
      detected,
    });
    await finalize({
      status: result.status,
      pr_url: result.prUrl ?? null,
      pr_number: result.prNumber ?? null,
      branch_name: result.branch ?? null,
    });
    await (svc as any).from("project_repos").upsert(
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
