"use server";

import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { serviceClient } from "@/lib/supabase/service";
import {
  checkAnonymousLimit,
  checkFreeManualQuota,
  checkPerTargetLimit,
  consumeCredit,
  hashIp,
  isAllowedTargetUrl,
  refundCredit,
} from "@/lib/rateLimit";
import {
  dedupeEngines,
  engineAvailable,
  ENGINES,
  selectionCost,
  type Engine,
} from "@/lib/credits";
import { newShareToken } from "@/lib/shareToken";
import { env } from "@/lib/env";
import { recordMarketingConsent } from "@/lib/marketing";

type ScanOk = {
  ok: true;
  audits: { id: string; engine: Engine; token: string }[];
  creditsSpent: number;
};
type Err = { ok: false; error: string };

async function notifyWorker(auditId: string, pdfEmail?: string) {
  if (!env.workerUrl) return;
  try {
    await fetch(`${env.workerUrl}/enqueue`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-worker-secret": env.workerSecret },
      body: JSON.stringify({ auditId, pdfEmail }),
    });
  } catch (err) {
    console.warn("[runAudit] worker notify failed; relying on sweep", err);
  }
}

const ALL_ENGINES: Engine[] = ["rule", "claude", "openai", "gemini", "qwen", "kimi", "deepseek"];

function normalizeEngines(input: unknown, signedIn: boolean): Engine[] {
  if (!signedIn) return ["rule"];
  if (!Array.isArray(input) || input.length === 0) return ["rule"];
  const cleaned = dedupeEngines(
    input.filter((e): e is Engine =>
      typeof e === "string" && (ALL_ENGINES as string[]).includes(e),
    ),
  );
  return cleaned.length === 0 ? ["rule"] : cleaned;
}

// Anonymous + signed-in entry from the homepage hero form. Anonymous always
// runs the rule engine; signed-in users get the per-target free quota for
// 'rule' and spend 1 credit each for paid engines.
export async function startAuditFromForm(input: {
  url: string;
  email?: string;
  engines?: Engine[];
  marketingOptIn?: boolean;
}): Promise<({ ok: true; id: string; token: string } & { engines: Engine[] }) | Err> {
  const check = isAllowedTargetUrl(input.url);
  if (!check.ok) return { ok: false, error: check.reason };
  const target = check.url;

  const hdrs = await headers();
  const ip =
    hdrs.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    hdrs.get("x-real-ip") ||
    "unknown";
  const ipH = hashIp(ip);

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const engines = normalizeEngines(input.engines, !!user);
  const unavailable = engines.find((e) => !engineAvailable(e));
  if (unavailable) {
    return { ok: false, error: `${ENGINES[unavailable].label} isn't wired up yet.` };
  }
  const cost = selectionCost(engines);

  if (!user) {
    const anon = await checkAnonymousLimit(ipH);
    if (!anon.ok) {
      return { ok: false, error: "Daily free audit limit reached for this IP. Sign up to use credits." };
    }
    if (!(await checkPerTargetLimit(target, null))) {
      return { ok: false, error: "This URL was just audited. Try again in a few minutes." };
    }
  } else {
    if (!(await checkPerTargetLimit(target, user.id))) {
      return { ok: false, error: "You just audited this URL. Try again in a few minutes." };
    }
    if (cost > 0) {
      const ok = await consumeCredit(user.id, cost);
      if (!ok.ok) {
        return { ok: false, error: `Need ${cost} credits for ${engines.length} engine${engines.length === 1 ? "" : "s"}; not enough balance. Buy credits in Billing.` };
      }
    } else {
      // Free rule engine: check 10/day-per-URL quota.
      const quota = await checkFreeManualQuota(user.id, target);
      if (!quota.free) {
        return { ok: false, error: `Free quota (${quota.cap}/day on this URL) used. Pick a paid engine.` };
      }
    }
  }

  const svc = serviceClient();
  // For the hero form we only create ONE audit (the form is single-engine
  // for anonymous; signed-in users use the project page for multi-engine).
  const firstEngine = engines[0];
  const token = newShareToken();
  const { data: row, error } = await svc
    .from("audits")
    .insert({
      target_url: target,
      owner_id: user?.id ?? null,
      status: "queued",
      share_token: token,
      triggered_by: "manual",
      engine: firstEngine,
      pdf_email: input.email ?? null,
    })
    .select("id, share_token")
    .single();
  if (error || !row) {
    if (cost > 0 && user) await refundCredit(user.id, cost);
    return { ok: false, error: error?.message ?? "Failed to create audit." };
  }

  await svc.from("usage_events").insert({
    owner_id: user?.id ?? null,
    ip_hash: ipH,
    kind: "audit_run",
    audit_id: row.id,
    meta: { from: "hero_form", email: input.email ?? null, engine: firstEngine, credits_spent: cost },
  });

  // Marketing list opt-in is independent of the PDF email — same address,
  // different consent. Best-effort: failure here must not break the audit.
  if (input.marketingOptIn && input.email) {
    try {
      await recordMarketingConsent({ email: input.email, source: "hero_form" });
    } catch (err) {
      console.warn("[runAudit] marketing consent record failed", err);
    }
  }

  await notifyWorker(row.id, input.email);
  return { ok: true, id: row.id, token: row.share_token!, engines: [firstEngine] };
}

// Multi-engine project scan. UI passes engines = ["claude","gemini"] etc.,
// confirmation already happened client-side; we deduct sum(engineCost(e))
// in a single atomic call, then queue one audit row per engine.
export async function runScanForProject(input: {
  projectId: string;
  url: string;
  engines: Engine[];
}): Promise<ScanOk | Err> {
  const check = isAllowedTargetUrl(input.url);
  if (!check.ok) return { ok: false, error: check.reason };
  const target = check.url;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  if (!(await checkPerTargetLimit(target, user.id))) {
    return { ok: false, error: "You just audited this URL. Try again in a few minutes." };
  }

  const engines = normalizeEngines(input.engines, true);
  const unavailable = engines.find((e) => !engineAvailable(e));
  if (unavailable) {
    return { ok: false, error: `${ENGINES[unavailable].label} isn't wired up yet.` };
  }

  const paidEngines = engines.filter((e) => ENGINES[e].cost > 0);
  const hasRule = engines.includes("rule");
  const cost = selectionCost(engines);

  // Rule engine: free quota check (only if rule is among the picks).
  if (hasRule) {
    const quota = await checkFreeManualQuota(user.id, target);
    if (!quota.free) {
      return { ok: false, error: `Free quota (${quota.cap}/day on this URL) used. Deselect 'Rule-based' or wait for the daily reset.` };
    }
  }

  // Atomic multi-credit deduction up front. If anything below fails we
  // refund the lot.
  if (cost > 0) {
    const ok = await consumeCredit(user.id, cost);
    if (!ok.ok) {
      return { ok: false, error: `Need ${cost} credit${cost === 1 ? "" : "s"} for ${engines.length} engine${engines.length === 1 ? "" : "s"}; not enough balance.` };
    }
  }

  const svc = serviceClient();
  const inserts = engines.map((e) => ({
    target_url: target,
    project_id: input.projectId,
    owner_id: user.id,
    status: "queued",
    share_token: newShareToken(),
    triggered_by: "manual",
    engine: e,
  }));
  const { data: rows, error } = await svc
    .from("audits")
    .insert(inserts)
    .select("id, share_token, engine");
  if (error || !rows) {
    if (cost > 0) await refundCredit(user.id, cost);
    return { ok: false, error: error?.message ?? "Failed to create audits." };
  }

  // Per-engine usage events + worker notify (fire-and-forget).
  await Promise.all(
    rows.map((r) =>
      svc.from("usage_events").insert({
        owner_id: user.id,
        kind: "audit_run",
        audit_id: r.id,
        meta: {
          from: "project",
          engine: r.engine,
          credits_spent: ENGINES[r.engine as Engine].cost,
        },
      }),
    ),
  );
  for (const r of rows) await notifyWorker(r.id);

  // Suppress unused-warning on paidEngines (it's documentation for now).
  void paidEngines;

  return {
    ok: true,
    creditsSpent: cost,
    audits: rows.map((r) => ({
      id: r.id,
      engine: r.engine as Engine,
      token: r.share_token!,
    })),
  };
}
