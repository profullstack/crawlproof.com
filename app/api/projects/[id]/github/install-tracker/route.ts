// POST /api/projects/[id]/github/install-tracker
// Body: { owner: string, repo: string, installation_id: number }
// Opens a PR on the chosen repo that adds the stats.js script tag.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { serviceClient } from "@/lib/supabase/service";
import { getOrMintInstallationToken } from "@/lib/github/installations";
import {
  installTracker,
  findInstallCandidates,
  previewInstallAtPath,
} from "@/lib/github/install-tracker";

export const runtime = "nodejs";

const bodySchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  installation_id: z.number().int().positive(),
  /** Optional subdirectory inside the repo where the app lives,
   *  e.g. "apps/web" or "sites/sh1pt.com". */
  root_path: z.string().max(500).optional(),
  /** When set: skip discovery, install at this exact path. */
  target_path: z.string().max(500).optional(),
  /** "candidates": return ranked candidate paths (no PR).
   *  "preview":    return the diff that would be applied at target_path.
   *  "submit":     open the PR (default). target_path required when set. */
  mode: z.enum(["candidates", "preview", "submit"]).optional(),
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

  // Ownership check on the project.
  const { data: project } = await supabase
    .from("projects")
    .select("id, owner_id")
    .eq("id", projectId)
    .maybeSingle();
  if (!project || project.owner_id !== user.id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Ownership check on the installation.
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

  // mode=candidates: just list candidate files; no PR, no run row.
  const mode = body.mode ?? "submit";
  if (mode === "candidates") {
    try {
      const token = await getOrMintInstallationToken(body.installation_id);
      const candidates = await findInstallCandidates({
        token,
        owner: body.owner,
        repo: body.repo,
        rootPath: body.root_path,
      });
      return NextResponse.json({ data: { candidates } });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return NextResponse.json({ error: msg }, { status: 500 });
    }
  }

  // mode=preview: show what the install at target_path would look like.
  if (mode === "preview") {
    if (!body.target_path) {
      return NextResponse.json(
        { error: "target_path is required for preview" },
        { status: 400 },
      );
    }
    try {
      const token = await getOrMintInstallationToken(body.installation_id);
      const preview = await previewInstallAtPath({
        token,
        owner: body.owner,
        repo: body.repo,
        path: body.target_path,
        projectId,
      });
      return NextResponse.json({ data: preview });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return NextResponse.json({ error: msg }, { status: 500 });
    }
  }

  // mode=submit: actually open the PR. Record the run row.
  const { data: run } = await (svc as any)
    .from("project_pr_runs")
    .insert({
      project_id: projectId,
      owner_id: user.id,
      kind: "install_tracker",
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
    const result = await installTracker({
      token,
      owner: body.owner,
      repo: body.repo,
      projectId,
      rootPath: body.root_path,
      targetPath: body.target_path,
    });
    await finalize({
      status: result.status,
      pr_url: result.prUrl ?? null,
      pr_number: result.prNumber ?? null,
      branch_name: result.branch ?? null,
    });
    return NextResponse.json({ data: result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await finalize({ status: "failed", error: msg });
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
