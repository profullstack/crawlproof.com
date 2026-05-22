// POST /api/projects/[id]/github/apply-fix
// Body: { owner, repo, installation_id, audit_id, finding_key }
// Consumes 1 credit, asks Claude to patch the repo for one specific
// audit finding, opens a PR. Refunds the credit on any failure.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { serviceClient } from "@/lib/supabase/service";
import { getOrMintInstallationToken } from "@/lib/github/installations";
import { applyFix } from "@/lib/github/apply-fix";

export const runtime = "nodejs";
export const maxDuration = 120; // Claude calls can take a while.

const bodySchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  installation_id: z.number().int().positive(),
  audit_id: z.string().uuid(),
  finding_key: z.string().min(1),
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

  // Ownership: project + installation must belong to the caller.
  const { data: project } = await supabase
    .from("projects")
    .select("id, owner_id")
    .eq("id", projectId)
    .maybeSingle();
  if (!project || project.owner_id !== user.id) {
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

  // Load the audit + finding to make sure both belong to this project.
  const { data: audit } = await supabase
    .from("audits")
    .select("id, target_url, project_id, owner_id")
    .eq("id", body.audit_id)
    .maybeSingle();
  if (
    !audit ||
    (audit as { project_id?: string }).project_id !== projectId ||
    (audit as { owner_id?: string }).owner_id !== user.id
  ) {
    return NextResponse.json({ error: "Audit not found" }, { status: 404 });
  }
  const { data: finding } = await supabase
    .from("audit_findings")
    .select("check_key, title, detail, section, priority, evidence")
    .eq("audit_id", body.audit_id)
    .eq("check_key", body.finding_key)
    .maybeSingle();
  if (!finding) {
    return NextResponse.json({ error: "Finding not found" }, { status: 404 });
  }

  const svc = serviceClient();

  // Consume the credit BEFORE doing any expensive work. The PG function
  // is atomic — returns false when the balance is insufficient.
  const { data: charged, error: chargeErr } = await (svc as any).rpc(
    "consume_credit",
    { p_owner: user.id, p_count: 1 },
  );
  if (chargeErr) {
    return NextResponse.json({ error: chargeErr.message }, { status: 500 });
  }
  if (!charged) {
    return NextResponse.json(
      { error: "Insufficient credits. Top up to apply fixes via GitHub." },
      { status: 402 },
    );
  }

  // Stamp the run row up front.
  const { data: run } = await (svc as any)
    .from("project_pr_runs")
    .insert({
      project_id: projectId,
      owner_id: user.id,
      kind: "apply_fix",
      installation_id: body.installation_id,
      repo_owner: body.owner,
      repo_name: body.repo,
      audit_id: body.audit_id,
      finding_key: body.finding_key,
      status: "running",
      credits_consumed: 1,
    })
    .select("id")
    .single();
  const runId = run?.id as string | undefined;

  async function refundAndFail(message: string) {
    if (runId) {
      await (svc as any)
        .from("project_pr_runs")
        .update({
          status: "failed",
          error: message,
          credits_refunded: 1,
          updated_at: new Date().toISOString(),
        })
        .eq("id", runId);
    }
    // Refund: increment the user's balance back by 1.
    const { data: prof } = await (svc as any)
      .from("profiles")
      .select("credits_balance")
      .eq("id", user!.id)
      .maybeSingle();
    if (prof) {
      await (svc as any)
        .from("profiles")
        .update({ credits_balance: (prof.credits_balance ?? 0) + 1 })
        .eq("id", user!.id);
    }
  }

  try {
    const token = await getOrMintInstallationToken(body.installation_id);
    const result = await applyFix({
      token,
      owner: body.owner,
      repo: body.repo,
      finding: {
        check_key: (finding as { check_key: string }).check_key,
        title: (finding as { title: string }).title,
        detail: (finding as { detail: string | null }).detail,
        section: (finding as { section: string }).section,
        priority: (finding as { priority: number }).priority,
        evidence: (finding as { evidence: unknown }).evidence,
      },
      targetUrl: (audit as { target_url: string }).target_url,
    });

    // A "noop" result still consumed the credit because we did call
    // Claude. That's the right behavior — paying for inference, not for
    // a PR specifically.
    if (runId) {
      await (svc as any)
        .from("project_pr_runs")
        .update({
          status: result.status,
          pr_url: result.prUrl ?? null,
          pr_number: result.prNumber ?? null,
          branch_name: result.branch ?? null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", runId);
    }
    return NextResponse.json({ data: result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await refundAndFail(msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
