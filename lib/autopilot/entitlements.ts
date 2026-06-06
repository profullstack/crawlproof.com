import type { SupabaseClient } from "@supabase/supabase-js";

export type ArticleChargeSource = "entitlement" | "credit" | "none";

export type CurrentProjectEntitlement = {
  id: string;
  projectId: string;
  subscriptionId: string | null;
  periodStart: string;
  periodEnd: string;
  articlesIncluded: number;
  articlesUsed: number;
  articlesRemaining: number;
  promptsIncluded: number;
  promptsUsed: number;
  fixPrsIncluded: number;
  fixPrsUsed: number;
  source: "subscription" | "manual";
};

type EntitlementRow = {
  id: string;
  project_id: string;
  subscription_id: string | null;
  period_start: string;
  period_end: string;
  articles_included: number;
  articles_used: number;
  prompts_included: number;
  prompts_used: number;
  fix_prs_included: number;
  fix_prs_used: number;
};

type SubscriptionRow = {
  id: string;
  user_id: string;
  status: string;
};

function mapEntitlement(
  row: EntitlementRow,
  source: "subscription" | "manual",
): CurrentProjectEntitlement {
  return {
    id: row.id,
    projectId: row.project_id,
    subscriptionId: row.subscription_id,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    articlesIncluded: row.articles_included,
    articlesUsed: row.articles_used,
    articlesRemaining: Math.max(0, row.articles_included - row.articles_used),
    promptsIncluded: row.prompts_included,
    promptsUsed: row.prompts_used,
    fixPrsIncluded: row.fix_prs_included,
    fixPrsUsed: row.fix_prs_used,
    source,
  };
}

export async function getCurrentProjectEntitlement(
  supabase: SupabaseClient<any>,
  projectId: string,
  ownerId: string,
  nowIso = new Date().toISOString(),
): Promise<CurrentProjectEntitlement | null> {
  const { data: rows, error } = await supabase
    .from("project_entitlements")
    .select(
      "id, project_id, subscription_id, period_start, period_end, articles_included, articles_used, prompts_included, prompts_used, fix_prs_included, fix_prs_used",
    )
    .eq("project_id", projectId)
    .lte("period_start", nowIso)
    .gt("period_end", nowIso)
    .order("period_start", { ascending: false })
    .limit(10);

  if (error || !rows?.length) return null;

  const typedRows = rows as EntitlementRow[];
  const manual = typedRows.find((row) => !row.subscription_id);
  const subscriptionIds = typedRows
    .map((row) => row.subscription_id)
    .filter((id): id is string => !!id);

  if (subscriptionIds.length > 0) {
    const { data: subs } = await supabase
      .from("subscriptions")
      .select("id, user_id, status")
      .in("id", subscriptionIds);
    const activeSubIds = new Set(
      ((subs ?? []) as SubscriptionRow[])
        .filter((sub) => sub.user_id === ownerId && sub.status === "active")
        .map((sub) => sub.id),
    );
    const subscriptionRow = typedRows.find(
      (row) => row.subscription_id && activeSubIds.has(row.subscription_id),
    );
    if (subscriptionRow) return mapEntitlement(subscriptionRow, "subscription");
  }

  return manual ? mapEntitlement(manual, "manual") : null;
}

export async function getArticleGenerationCapacity(
  supabase: SupabaseClient<any>,
  projectId: string,
  ownerId: string,
): Promise<{
  ok: boolean;
  source: ArticleChargeSource;
  entitlement: CurrentProjectEntitlement | null;
  creditsBalance: number;
}> {
  const entitlement = await getCurrentProjectEntitlement(
    supabase,
    projectId,
    ownerId,
  );
  if (entitlement && entitlement.articlesRemaining > 0) {
    return {
      ok: true,
      source: "entitlement",
      entitlement,
      creditsBalance: 0,
    };
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("credits_balance")
    .eq("id", ownerId)
    .maybeSingle();
  const creditsBalance =
    (profile?.credits_balance as number | null | undefined) ?? 0;
  return {
    ok: creditsBalance >= 1,
    source: creditsBalance >= 1 ? "credit" : "none",
    entitlement,
    creditsBalance,
  };
}

export async function consumeArticleGenerationCharge(
  supabase: SupabaseClient<any>,
  projectId: string,
  ownerId: string,
): Promise<ArticleChargeSource> {
  const { data, error } = await supabase.rpc("consume_article_generation", {
    p_project: projectId,
    p_owner: ownerId,
  });
  if (error) {
    console.warn("[autopilot] article charge RPC failed", error.message);
    return "none";
  }
  return data === "entitlement" || data === "credit" ? data : "none";
}

export async function refundArticleGenerationCharge(
  supabase: SupabaseClient<any>,
  input: {
    projectId: string;
    ownerId: string;
    source: ArticleChargeSource;
  },
): Promise<void> {
  if (input.source === "entitlement") {
    const { error } = await supabase.rpc("refund_article_entitlement", {
      p_project: input.projectId,
      p_owner: input.ownerId,
    });
    if (error) {
      console.warn("[autopilot] entitlement refund failed", error.message);
    }
    return;
  }

  if (input.source === "credit") {
    const { data: prof, error: readErr } = await supabase
      .from("profiles")
      .select("credits_balance")
      .eq("id", input.ownerId)
      .maybeSingle();
    if (readErr || !prof) {
      console.warn("[autopilot] credit refund read failed", readErr?.message);
      return;
    }
    const { error: updErr } = await supabase
      .from("profiles")
      .update({ credits_balance: (prof.credits_balance ?? 0) + 1 })
      .eq("id", input.ownerId);
    if (updErr) {
      console.warn("[autopilot] credit refund update failed", updErr.message);
    }
  }
}

