// POST /api/ads/slots/[id]/install-embed
// Opens a PR on the publisher's repo that adds the /ad.js embed for this slot.
// Mirrors the stats.js install-tracker route.
//
// Body:
//   {}                                  -> resolve repos bound to the slot's
//                                          project. Auto-submits when exactly
//                                          one is bound; otherwise returns the
//                                          list for the caller to pick from.
//   { owner, repo, installation_id }    -> open the PR on that repo.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { serviceClient } from "@/lib/supabase/service";
import { getOrMintInstallationToken } from "@/lib/github/installations";
import { installAdEmbed } from "@/lib/github/install-ad";

export const runtime = "nodejs";

const bodySchema = z.object({
  owner: z.string().min(1).optional(),
  repo: z.string().min(1).optional(),
  installation_id: z.number().int().positive().optional(),
  target_path: z.string().max(500).optional(),
});

type BoundRepo = {
  repo_owner: string;
  repo_name: string;
  installation_id: number;
  default_branch: string | null;
};

export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id: slotId } = await ctx.params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body;
  try {
    body = bodySchema.parse(await request.json().catch(() => ({})));
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }

  // Slot must belong to this user (RLS-scoped read).
  const { data: slot } = await supabase
    .from("ad_slots")
    .select("id, project_id")
    .eq("id", slotId)
    .maybeSingle();
  if (!slot) return NextResponse.json({ error: "Slot not found" }, { status: 404 });

  const svc = serviceClient();

  // Resolve target repo. Explicit body wins; else use repos bound to the project.
  let owner = body.owner;
  let repo = body.repo;
  let installationId = body.installation_id;

  if (!owner || !repo || !installationId) {
    const { data: bound } = await svc
      .from("project_repos")
      .select("repo_owner, repo_name, installation_id, default_branch")
      .eq("project_id", slot.project_id);
    const repos = (bound as BoundRepo[]) ?? [];
    if (repos.length === 0) {
      return NextResponse.json(
        {
          error:
            "No GitHub repo is connected to this project yet. Connect one from the project's Stats → install step first.",
        },
        { status: 409 },
      );
    }
    if (repos.length > 1) {
      // Let the caller choose which repo.
      return NextResponse.json({
        data: {
          needsRepo: true,
          repos: repos.map((r) => ({
            owner: r.repo_owner,
            repo: r.repo_name,
            installation_id: r.installation_id,
          })),
        },
      });
    }
    owner = repos[0].repo_owner;
    repo = repos[0].repo_name;
    installationId = repos[0].installation_id;
  }

  // Installation must belong to this user.
  const { data: installation } = await supabase
    .from("github_installations")
    .select("installation_id")
    .eq("installation_id", installationId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!installation) {
    return NextResponse.json(
      { error: "GitHub installation not connected to this account" },
      { status: 403 },
    );
  }

  try {
    const token = await getOrMintInstallationToken(installationId!);
    const result = await installAdEmbed({
      token,
      owner: owner!,
      repo: repo!,
      slotId,
      targetPath: body.target_path,
    });
    return NextResponse.json({ data: result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
