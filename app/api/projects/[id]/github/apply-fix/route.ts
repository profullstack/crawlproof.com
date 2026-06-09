// POST /api/projects/[id]/github/apply-fix
// Body: { owner, repo, installation_id, audit_id, finding_key, prompt?, fix_prompt? }
// Consumes SCAN_CREDITS credits, asks Claude to patch the repo for one
// specific audit finding, opens a PR. Refunds the credits on any failure.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { serviceClient } from "@/lib/supabase/service";
import { requireProjectAccess } from "@/lib/lx/currentSite";
import { getOrMintInstallationToken } from "@/lib/github/installations";
import {
  MAX_APPLY_FIX_PROMPT_LENGTH,
  MAX_LEGACY_FIX_PROMPT_LENGTH,
  APPLY_FIX_MODEL_LABEL,
  applyFix,
  buildDefaultApplyFixPrompt,
} from "@/lib/github/apply-fix";
import { getRepo } from "@/lib/github/repos";
import { SCAN_CREDITS } from "@/lib/credits";

export const runtime = "nodejs";
// Agentic mode runs up to 20 Claude tool turns; each turn ~5s. Worst
// case is ~2 minutes, but realistic fixes finish in 20-40s.
export const maxDuration = 300;

const APPLY_FIX_MIN_TOKEN_TTL_MS = 15 * 60_000;

const bodySchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  installation_id: z.number().int().positive(),
  audit_id: z.string().uuid(),
  finding_key: z.string().min(1),
  prompt: z.string().max(MAX_APPLY_FIX_PROMPT_LENGTH).optional(),
  fix_prompt: z.string().max(MAX_LEGACY_FIX_PROMPT_LENGTH).optional(),
  /** Optional starting hint for monorepos (e.g. "apps/web"). */
  root_path: z.string().max(500).optional(),
  /** Return a server-sent event stream from POST so large edited prompts stay in the request body. */
  stream: z.boolean().optional(),
});

const querySchema = bodySchema.extend({
  installation_id: z.coerce.number().int().positive(),
  stream: z
    .enum(["true", "false", "1", "0"])
    .optional()
    .transform((value) => value === "true" || value === "1"),
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

async function loadApplyFixContext(args: {
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
    .select("id, target_url, project_id, owner_id, engine")
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

  return {
    audit: audit as {
      id: string;
      target_url: string;
      project_id: string;
      owner_id: string;
      engine: string | null;
    },
    finding: finding as {
      check_key: string;
      title: string;
      detail: string | null;
      section: string;
      priority: number;
      evidence: unknown;
    },
  };
}

async function buildPromptPreview(args: {
  projectId: string;
  userId: string;
  supabase: Awaited<ReturnType<typeof createClient>>;
  body: ApplyFixBody;
}) {
  const { projectId, userId, supabase, body } = args;
  const { audit, finding } = await loadApplyFixContext({
    projectId,
    userId,
    supabase,
    body,
  });
  const token = await getOrMintInstallationToken(body.installation_id);
  const repoMeta = await getRepo({
    token,
    owner: body.owner,
    repo: body.repo,
  });
  const prompt = buildDefaultApplyFixPrompt({
    finding,
    targetUrl: audit.target_url,
    defaultBranch: repoMeta.default_branch,
    projectId,
    auditId: body.audit_id,
    auditEngine: audit.engine,
    repoFullName: `${body.owner}/${body.repo}`,
    rootPath: body.root_path,
    userPrompt: cleanOptionalPrompt(body.fix_prompt),
  });
  return {
    prompt,
    model: APPLY_FIX_MODEL_LABEL,
    defaultBranch: repoMeta.default_branch,
  };
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
  const { audit, finding } = await loadApplyFixContext({
    projectId,
    userId,
    supabase,
    body,
    onProgress,
  });

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
    const token = await getOrMintInstallationToken(body.installation_id, {
      minTtlMs: APPLY_FIX_MIN_TOKEN_TTL_MS,
    });
    await progress("Starting Claude fix agent…");
    const result = await applyFix({
      token,
      owner: body.owner,
      repo: body.repo,
      finding,
      targetUrl: audit.target_url,
      projectId,
      auditId: body.audit_id,
      auditEngine: audit.engine,
      rootPath: body.root_path,
      prompt: cleanOptionalPrompt(body.prompt),
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

function createApplyFixStream(args: {
  projectId: string;
  userId: string;
  supabase: Awaited<ReturnType<typeof createClient>>;
  body: ApplyFixBody;
}) {
  const { projectId, userId, supabase, body } = args;
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
        userId,
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
    if (body.stream) {
      return createApplyFixStream({
        projectId,
        userId: user.id,
        supabase,
        body,
      });
    }
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
  let previewPrompt = false;
  try {
    const url = new URL(request.url);
    body = querySchema.parse(Object.fromEntries(url.searchParams.entries()));
    previewPrompt = url.searchParams.get("preview_prompt") === "1";
  } catch {
    return new Response("Bad request", { status: 400 });
  }

  if (previewPrompt) {
    try {
      const data = await buildPromptPreview({
        projectId,
        userId: user.id,
        supabase,
        body,
      });
      return NextResponse.json({ data });
    } catch (err) {
      const status = err instanceof RouteError ? err.status : 500;
      return NextResponse.json({ error: routeErrorMessage(err) }, { status });
    }
  }

  return createApplyFixStream({
    projectId,
    userId: user.id,
    supabase,
    body,
  });
}
