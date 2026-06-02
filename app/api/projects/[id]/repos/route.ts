// POST /api/projects/[id]/repos — bind a repo (body: { installation_id, owner, repo, default_branch })
// GET  /api/projects/[id]/repos — list bound repos
// (Per-repo DELETE lives at /api/projects/[id]/repos/[repoId])

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireProjectAccess } from "@/lib/lx/currentSite";

const bodySchema = z.object({
  installation_id: z.number().int().positive(),
  owner: z.string().min(1).max(120),
  repo: z.string().min(1).max(200),
  default_branch: z.string().max(200).optional(),
});

export async function GET(
  _request: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: projectId } = await ctx.params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { data } = await supabase
    .from("project_repos")
    .select("id, installation_id, repo_owner, repo_name, default_branch, added_at")
    .eq("project_id", projectId)
    .order("added_at", { ascending: false });
  return NextResponse.json({ data: data ?? [] });
}

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

  // Project access (owner or member).
  const access = await requireProjectAccess(projectId);
  if (!access.ok) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Installation must belong to this user (RLS handles this; explicit
  // check gives us a clear 403 instead of a silent zero-row read).
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

  const { data, error } = await (supabase as any)
    .from("project_repos")
    .upsert(
      {
        project_id: projectId,
        installation_id: body.installation_id,
        repo_owner: body.owner,
        repo_name: body.repo,
        default_branch: body.default_branch ?? null,
        added_by: user.id,
      },
      { onConflict: "project_id,repo_owner,repo_name" },
    )
    .select()
    .single();
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  return NextResponse.json({ data });
}
