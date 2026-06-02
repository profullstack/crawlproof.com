"use server";

import crypto from "node:crypto";
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
import { requireProjectAccess } from "@/lib/lx/currentSite";
import {
  dedupeEngines,
  engineAvailable,
  ENGINES,
  selectionCost,
  type Engine,
} from "@/lib/credits";
import { newShareToken } from "@/lib/shareToken";
import { env } from "@/lib/env";
import { recordMarketingConsent, recordLead } from "@/lib/marketing";

type ScanOk = {
  ok: true;
  scanRunId: string;
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

const ALL_ENGINES: Engine[] = ["rule", "spec", "claude", "openai", "gemini", "qwen", "kimi", "deepseek", "perplexity"];

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
  phone?: string;
  estimatedMonthlySales?: string;
  engines?: Engine[];
  marketingOptIn?: boolean;
  listPublic?: boolean;
}): Promise<({ ok: true; id: string; token: string } & { engines: Engine[] }) | Err> {
  const check = isAllowedTargetUrl(input.url);
  if (!check.ok) return { ok: false, error: check.reason };
  const target = check.url;

  const email = input.email?.trim();
  if (email && !email.includes("@")) {
    return { ok: false, error: "Enter a valid email address." };
  }
  if (input.marketingOptIn && !email) {
    return { ok: false, error: "Email is required for marketing updates." };
  }

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
      return { ok: false, error: "This URL was just audited. Try again in 30 seconds." };
    }
  } else {
    if (!(await checkPerTargetLimit(target, user.id))) {
      return { ok: false, error: "You just audited this URL. Try again in 30 seconds." };
    }
    if (cost > 0) {
      const ok = await consumeCredit(user.id, cost);
      if (!ok.ok) {
        return { ok: false, error: `Need ${cost} credits for ${engines.length} engine${engines.length === 1 ? "" : "s"}; not enough balance. Buy credits in Billing.` };
      }
    }
    // Signed-in users have no daily ceiling on the free rule engine —
    // the per-target back-to-back gate above is enough abuse protection.
  }

  const svc = serviceClient();
  // For the hero form we only create ONE audit (the form is single-engine
  // for anonymous; signed-in users use the project page for multi-engine).
  const firstEngine = engines[0];
  const token = newShareToken();
  const salesRaw = input.estimatedMonthlySales?.trim();
  const salesParsed =
    salesRaw && Number.isFinite(Number(salesRaw)) ? Number(salesRaw) : null;
  const insertPayload: Record<string, unknown> = {
    target_url: target,
    owner_id: user?.id ?? null,
    status: "queued",
    share_token: token,
    triggered_by: "manual",
    engine: firstEngine,
    pdf_email: email || null,
    phone: input.phone?.trim() || null,
    estimated_monthly_sales: salesParsed,
    listed_public: !!input.listPublic,
  };
  let { data: row, error } = await svc
    .from("audits")
    .insert(insertPayload)
    .select("id, share_token")
    .single();
  if (
    error &&
    /listed_public|schema cache|column/i.test(error.message ?? "")
  ) {
    delete insertPayload.listed_public;
    const retry = await svc
      .from("audits")
      .insert(insertPayload)
      .select("id, share_token")
      .single();
    row = retry.data;
    error = retry.error;
  }
  if (error || !row) {
    if (cost > 0 && user) await refundCredit(user.id, cost);
    return { ok: false, error: error?.message ?? "Failed to create audit." };
  }

  await svc.from("usage_events").insert({
    owner_id: user?.id ?? null,
    ip_hash: ipH,
    kind: "audit_run",
    audit_id: row.id,
    meta: {
      from: "hero_form",
      email: email || null,
      phone: input.phone?.trim() || null,
      estimated_monthly_sales: salesParsed,
      engine: firstEngine,
      credits_spent: cost,
      listed_public: !!input.listPublic,
    },
  });

  // Lead capture: every hero-form submission lands in
  // marketing_contacts. Tick → consented_at=now() (real opt-in).
  // Unticked → consented_at=NULL (lead only, no marketing sends).
  // Best-effort: failures must not break the audit.
  if (email) {
    try {
      if (input.marketingOptIn) {
        await recordMarketingConsent({ email, source: "hero_form" });
      } else {
        await recordLead({ email, source: "hero_form" });
      }
    } catch (err) {
      console.warn("[runAudit] lead/consent record failed", err);
    }
  }

  await notifyWorker(row.id, email || undefined);
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

  const access = await requireProjectAccess(input.projectId);
  if (!access.ok) return { ok: false, error: "Not found." };
  const { userId: uid, userEmail } = access;

  if (!(await checkPerTargetLimit(target, uid))) {
    return { ok: false, error: "You just audited this URL. Try again in 30 seconds." };
  }

  const engines = normalizeEngines(input.engines, true);
  const unavailable = engines.find((e) => !engineAvailable(e));
  if (unavailable) {
    return { ok: false, error: `${ENGINES[unavailable].label} isn't wired up yet.` };
  }

  const cost = selectionCost(engines);

  // No daily free-quota gate for signed-in users — the per-target
  // back-to-back limit is the only rate guard. Rate-limiting / daily
  // caps apply to anonymous (logged-out) users only.

  // Atomic multi-credit deduction up front. If anything below fails we
  // refund the lot.
  if (cost > 0) {
    const ok = await consumeCredit(uid, cost);
    if (!ok.ok) {
      return { ok: false, error: `Need ${cost} credit${cost === 1 ? "" : "s"} for ${engines.length} engine${engines.length === 1 ? "" : "s"}; not enough balance.` };
    }
  }

  const svc = serviceClient();
  // Default the PDF-receipt email to the signed-in user's address. The hero
  // form takes an explicit email; the project page doesn't ask, so we use
  // the account email — matches the user's expectation of "I'll get the
  // report emailed to me."
  const pdfEmail = userEmail;
  // Shared scan_run_id ties the N audits from this click together so the
  // runs/<runId> page can show every engine side-by-side.
  const scanRunId = crypto.randomUUID();
  const inserts = engines.map((e) => ({
    target_url: target,
    project_id: input.projectId,
    owner_id: uid,
    status: "queued",
    share_token: newShareToken(),
    triggered_by: "manual",
    engine: e,
    pdf_email: pdfEmail,
    scan_run_id: scanRunId,
  }));
  const { data: rows, error } = await svc
    .from("audits")
    .insert(inserts)
    .select("id, share_token, engine");
  if (error || !rows) {
    if (cost > 0) await refundCredit(uid, cost);
    return { ok: false, error: error?.message ?? "Failed to create audits." };
  }

  // Per-engine usage events + worker notify (fire-and-forget).
  await Promise.all(
    rows.map((r) =>
      svc.from("usage_events").insert({
        owner_id: uid,
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
  for (const r of rows) await notifyWorker(r.id, pdfEmail ?? undefined);

  return {
    ok: true,
    creditsSpent: cost,
    scanRunId,
    audits: rows.map((r) => ({
      id: r.id,
      engine: r.engine as Engine,
      token: r.share_token!,
    })),
  };
}
