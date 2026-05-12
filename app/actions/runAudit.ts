"use server";

import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { serviceClient } from "@/lib/supabase/service";
import {
  checkAnonymousLimit,
  checkPerTargetLimit,
  consumeCredit,
  hashIp,
  isAllowedTargetUrl,
  refundCredit,
} from "@/lib/rateLimit";
import { newShareToken } from "@/lib/shareToken";
import { env } from "@/lib/env";

type Ok = { ok: true; id: string; token: string };
type Err = { ok: false; error: string };

async function notifyWorker(auditId: string, pdfEmail?: string) {
  if (!env.workerUrl) return; // worker not configured; sweep will pick it up
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

// Anonymous + signed-in entry from the homepage hero form.
// Anonymous users get 3 free scans per day per IP. Signed-in users spend
// 1 credit per scan from their balance.
export async function startAuditFromForm(input: {
  url: string;
  email?: string;
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

  let creditSpent = false;

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
    const credit = await consumeCredit(user.id);
    if (!credit.ok) {
      return { ok: false, error: "Out of scan credits. Buy more from Billing." };
    }
    creditSpent = true;
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
    })
    .select("id, share_token")
    .single();
  if (error || !row) {
    if (creditSpent && user) await refundCredit(user.id);
    return { ok: false, error: error?.message ?? "Failed to create audit." };
  }

  await svc.from("usage_events").insert({
    owner_id: user?.id ?? null,
    ip_hash: ipH,
    kind: "audit_run",
    audit_id: row.id,
    meta: { from: "hero_form", email: input.email ?? null, credit_spent: creditSpent },
  });

  await notifyWorker(row.id, input.email);

  return { ok: true, id: row.id, token: row.share_token! };
}

// Re-run from a project page (signed-in only). Costs 1 credit.
export async function runAuditForProject(input: {
  projectId: string;
  url: string;
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

  const credit = await consumeCredit(user.id);
  if (!credit.ok) {
    return { ok: false, error: "Out of scan credits. Buy more from Billing." };
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
    })
    .select("id")
    .single();
  if (error || !row) {
    await refundCredit(user.id);
    return { ok: false, error: error?.message ?? "Failed." };
  }

  await svc.from("usage_events").insert({
    owner_id: user.id,
    kind: "audit_run",
    audit_id: row.id,
    meta: { from: "project", credit_spent: true },
  });

  await notifyWorker(row.id);
  return { ok: true, id: row.id };
}
