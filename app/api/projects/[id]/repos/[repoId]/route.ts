// DELETE /api/projects/[id]/repos/[repoId] — unbind a repo from a project.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function DELETE(
  _request: NextRequest,
  ctx: { params: Promise<{ id: string; repoId: string }> },
) {
  const { id: projectId, repoId } = await ctx.params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // RLS scopes the delete; the explicit eq is belt-and-suspenders.
  const { error } = await supabase
    .from("project_repos")
    .delete()
    .eq("id", repoId)
    .eq("project_id", projectId);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  return new NextResponse(null, { status: 204 });
}
