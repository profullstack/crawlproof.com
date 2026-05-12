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
import { engineAvailable, engineCost, ENGINES, type Engine } from "@/lib/credits";
import { newShareToken } from "@/lib/shareToken";
import { env } from "@/lib/env";

type Ok = { ok: true; id: string; token: string };
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

function normalizeEngine(input: string | undefined, signedIn: boolean): Engine {
  if (!signedIn) return "rule";
  const known: Engine[] = ["rule", "claude", "openai", "qwen", "kimi", "gemini"];
  if (input && (known as string[]).includes(input)) return input as Engine;
  return "rule";
}

// Anonymous + signed-in entry from the homepage hero form.
// - Anonymous → rule engine, 3 / day / IP.
// - Signed-in → rule (free quota 10/day/URL), claude (1 credit), openai (2 credits).
export async function startAuditFromForm(input: {
  url: string;
  email?: string;
  engine?: Engine;
}): Promise<Ok | Err> {
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

  const engine = normalizeEngine(input.engine, !!user);
  if (!engineAvailable(engine)) {
    return {
      ok: false,
      error: `${ENGINES[engine].label} isn't wired up yet. Pick another engine.`,
    };
  }
  const cost = engineCost(engine);
  let creditsSpent = 0;

  if (!user) {
    const anon = await checkAnonymousLimit(ipH);
    if (!anon.ok) {
      return {
        ok: false,
        error: "Daily free audit limit reached for this IP. Sign up to use credits.",
      };
    }
    if (!(await checkPerTargetLimit(target, null))) {
      return { ok: false, error: "This URL was just audited. Try again in a few minutes." };
    }
  } else {
    if (!(await checkPerTargetLimit(target, user.id))) {
      return { ok: false, error: "You just audited this URL. Try again in a few minutes." };
    }
    // Free 10/day manual quota only applies to the rule engine.
    if (engine === "rule") {
      const quota = await checkFreeManualQuota(user.id, target);
      if (!quota.free) {
        return {
          ok: false,
          error: `Free quota (${quota.cap}/day on this URL) used. Pick Claude or OpenAI to use credits.`,
        };
      }
    } else if (cost > 0) {
      const credit = await consumeCredit(user.id, cost);
      if (!credit.ok) {
        return {
          ok: false,
          error: `${ENGINES[engine].label} costs ${cost} credit${cost === 1 ? "" : "s"} — not enough balance. Buy credits in Billing.`,
        };
      }
      creditsSpent = cost;
    }
  }

  const svc = serviceClient();
  const token = newShareToken();
  const { data: row, error } = await svc
    .from("audits")
    .insert({
      target_url: target,
      owner_id: user?.id ?? null,
      status: "queued",
      share_token: token,
      triggered_by: "manual",
      engine,
    })
    .select("id, share_token")
    .single();
  if (error || !row) {
    if (creditsSpent > 0 && user) await refundCredit(user.id, creditsSpent);
    return { ok: false, error: error?.message ?? "Failed to create audit." };
  }

  await svc.from("usage_events").insert({
    owner_id: user?.id ?? null,
    ip_hash: ipH,
    kind: "audit_run",
    audit_id: row.id,
    meta: {
      from: "hero_form",
      email: input.email ?? null,
      engine,
      credits_spent: creditsSpent,
    },
  });

  await notifyWorker(row.id, input.email);
  return { ok: true, id: row.id, token: row.share_token! };
}

// Re-run from a project page (signed-in only). Engine and cost decided here.
export async function runAuditForProject(input: {
  projectId: string;
  url: string;
  engine?: Engine;
}): Promise<{ ok: true; id: string } | Err> {
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

  const engine = normalizeEngine(input.engine, true);
  const cost = engineCost(engine);
  let creditsSpent = 0;

  if (engine === "rule") {
    const quota = await checkFreeManualQuota(user.id, target);
    if (!quota.free) {
      return {
        ok: false,
        error: `Free quota (${quota.cap}/day on this URL) used. Pick Claude or OpenAI to use credits.`,
      };
    }
  } else if (cost > 0) {
    const credit = await consumeCredit(user.id, cost);
    if (!credit.ok) {
      return {
        ok: false,
        error: `${ENGINES[engine].label} costs ${cost} credit${cost === 1 ? "" : "s"} — not enough balance. Buy credits in Billing.`,
      };
    }
    creditsSpent = cost;
  }

  const svc = serviceClient();
  const token = newShareToken();
  const { data: row, error } = await svc
    .from("audits")
    .insert({
      target_url: target,
      project_id: input.projectId,
      owner_id: user.id,
      status: "queued",
      share_token: token,
      triggered_by: "manual",
      engine,
    })
    .select("id")
    .single();
  if (error || !row) {
    if (creditsSpent > 0) await refundCredit(user.id, creditsSpent);
    return { ok: false, error: error?.message ?? "Failed." };
  }

  await svc.from("usage_events").insert({
    owner_id: user.id,
    kind: "audit_run",
    audit_id: row.id,
    meta: { from: "project", engine, credits_spent: creditsSpent },
  });

  await notifyWorker(row.id);
  return { ok: true, id: row.id };
}
