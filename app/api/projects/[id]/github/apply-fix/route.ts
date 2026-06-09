// POST /api/projects/[id]/github/apply-fix
// Body: { owner, repo, installation_id, audit_id, finding_key, fix_prompt? }
// Consumes SCAN_CREDITS credits, asks Claude to patch the repo for one
// specific audit finding, opens a PR. Refunds the credits on any failure.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { serviceClient } from "@/lib/supabase/service";
import { requireProjectAccess } from "@/lib/lx/currentSite";
import { getOrMintInstallationToken } from "@/lib/github/installations";
import { applyFix } from "@/lib/github/apply-fix";
import { SCAN_CREDITS } from "@/lib/credits";

export const runtime = "nodejs";
// Agentic mode runs up to 20 Claude tool turns; each turn ~5s. Worst
// case is ~2 minutes, but realistic fixes finish in 20-40s.
export const maxDuration = 300;

const bodySchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  installation_id: z.number().int().positive(),
  audit_id: z.string().uuid(),
  finding_key: z.string().min(1),
  fix_prompt: z.string().max(2000).optional(),
  /** Optional starting hint for monorepos (e.g. "apps/web"). */
  root_path: z.string().max(500).optional(),
});

const querySchema = bodySchema.extend({
  installation_id: z.coerce.number().int().positive(),
});

type ApplyFixBody = z.infer<typeof bodySchema>;

class RouteError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

function routeErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function cleanOptionalPrompt(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

async function runApplyFixJob(args: {
  projectId: string;
  userId: string;
  supabase: Awaited<ReturnType<typeof createClient>>;
  body: ApplyFixBody;
  onProgress?: (message: string) => void | Promise<void>;
}) {
  const { projectId, userId, supabase, body, onProgress } = args;
  const progress = async (message: string) => {
    await onProgress?.(message);
  };

  await progress("Checking project access…");
  const access = await requireProjectAccess(projectId);
  if (!access.ok) {
    throw new RouteError(404, "Not found");
  }

  await progress("Verifying GitHub installation…");
  const { data: installation } = await supabase
    .from("github_installations")
    .select("installation_id")
    .eq("installation_id", body.installation_id)
    .eq("user_id", userId)
    .maybeSingle();
  if (!installation) {
    throw new RouteError(403, "Installation not connected to this account");
  }

  await progress("Loading audit and finding…");
  const { data: audit } = await supabase
    .from("audits")
    .select("id, target_url, project_id, owner_id")
    .eq("id", body.audit_id)
    .maybeSingle();
  if (!audit || (audit as { project_id?: string }).project_id !== projectId) {
    throw new RouteError(404, "Audit not found");
  }

  const { data: finding } = await supabase
    .from("audit_findings")
    .select("check_key, title, detail, section, priority, evidence")
    .eq("audit_id", body.audit_id)
    .eq("check_key", body.finding_key)
    .maybeSingle();
  if (!finding) {
    throw new RouteError(404, "Finding not found");
  }

  const svc = serviceClient();

  await progress(`Charging ${SCAN_CREDITS} credits…`);
  const { data: charged, error: chargeErr } = await (svc as any).rpc(
    "consume_credit",
    { p_owner: userId, p_count: SCAN_CREDITS },
  );
  if (chargeErr) {
    throw new RouteError(500, chargeErr.message);
  }
  if (!charged) {
    throw new RouteError(
      402,
      "Insufficient credits. Top up to apply fixes via GitHub.",
    );
  }

  await progress("Recording PR run…");
  const { data: run } = await (svc as any)
    .from("project_pr_runs")
    .insert({
      project_id: projectId,
      owner_id: userId,
      kind: "apply_fix",
      installation_id: body.installation_id,
      repo_owner: body.owner,
      repo_name: body.repo,
      audit_id: body.audit_id,
      finding_key: body.finding_key,
      status: "running",
      credits_consumed: SCAN_CREDITS,
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
          credits_refunded: SCAN_CREDITS,
          updated_at: new Date().toISOString(),
        })
        .eq("id", runId);
    }
    const { data: prof } = await (svc as any)
      .from("profiles")
      .select("credits_balance")
      .eq("id", userId)
      .maybeSingle();
    if (prof) {
      await (svc as any)
        .from("profiles")
        .update({ credits_balance: (prof.credits_balance ?? 0) + SCAN_CREDITS })
        .eq("id", userId);
    }
  }

  try {
    await progress("Minting GitHub installation token…");
    const token = await getOrMintInstallationToken(body.installation_id);
    await progress("Starting Claude fix agent…");
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
      rootPath: body.root_path,
      userPrompt: cleanOptionalPrompt(body.fix_prompt),
      onProgress,
    });

    if (runId) {
      await progress("Saving PR run result…");
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
    await progress(
      result.status === "opened"
        ? "Pull request opened."
        : "Finished without opening a PR.",
    );
    return result;
  } catch (err) {
    const msg = routeErrorMessage(err);
    await progress(`Failed: ${msg}`);
    await refundAndFail(msg);
    throw new RouteError(500, msg);
  }
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
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: ApplyFixBody;
  try {
    body = bodySchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }

  try {
    const result = await runApplyFixJob({
      projectId,
      userId: user.id,
      supabase,
      body,
    });
    return NextResponse.json({ data: result });
  } catch (err) {
    const status = err instanceof RouteError ? err.status : 500;
    return NextResponse.json({ error: routeErrorMessage(err) }, { status });
  }
}

export async function GET(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: projectId } = await ctx.params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return new Response("Unauthorized", { status: 401 });
  }

  let body: ApplyFixBody;
  try {
    const url = new URL(request.url);
    body = querySchema.parse(Object.fromEntries(url.searchParams.entries()));
  } catch {
    return new Response("Bad request", { status: 400 });
  }

  const encoder = new TextEncoder();
  const stream = new TransformStream<Uint8Array, Uint8Array>();
  const writer = stream.writable.getWriter();

  const send = (event: string, data: unknown) => {
    try {
      void writer.write(
        encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
      );
    } catch {
      // Client disconnected.
    }
  };

  (async () => {
    try {
      send("status", {
        message: `Starting fix for ${body.owner}/${body.repo}…`,
      });
      const result = await runApplyFixJob({
        projectId,
        userId: user.id,
        supabase,
        body,
        onProgress: (message) => send("status", { message }),
      });
      send("done", result);
    } catch (err) {
      send("failed", {
        message: routeErrorMessage(err),
        status: err instanceof RouteError ? err.status : 500,
      });
    } finally {
      try {
        await writer.close();
      } catch {
        // Already closed.
      }
    }
  })();

  return new Response(stream.readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
