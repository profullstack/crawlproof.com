"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { serviceClient } from "@/lib/supabase/service";
import { env } from "@/lib/env";
import { getCategory, type Recency } from "@/lib/alerts/categories";
import { previewAlert } from "@/lib/alerts/engine";
import {
  MAX_ACTIVE_ALERTS,
  SERP_CALLS_PER_MONTH,
  allowedFrequencies,
  planFromProfile,
} from "@/lib/alerts/limits";
import {
  isValidEmail,
  isDisposableEmail,
  validateTerm,
  validateCompiledQuery,
} from "@/lib/alerts/validate";
import type { SerpResult } from "@/lib/alerts/valueserp";

type Ok<T = Record<string, unknown>> = { ok: true } & T;
type Err = { ok: false; error: string };

async function requireUser(): Promise<
  { ok: true; userId: string; email: string; plan: string } | Err
> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };
  const svc = serviceClient();
  const { data: profile } = await svc
    .from("profiles")
    .select("plan, email")
    .eq("id", user.id)
    .maybeSingle();
  return {
    ok: true,
    userId: user.id,
    email: (profile?.email as string) ?? user.email ?? "",
    plan: (profile?.plan as string) ?? "free",
  };
}

function siteOrigin(): string {
  return env.siteUrl.replace(/\/$/, "");
}

// Compile a category + term into the persisted alert fields.
function build(input: { category: string; term: string; customQuery?: string }) {
  const cat = getCategory(input.category);
  if (!cat) return { ok: false as const, error: "Unknown category." };
  const termCheck = validateTerm(input.category === "custom" ? input.customQuery ?? "" : input.term);
  if (!termCheck.ok) return termCheck;
  const compiled = cat.compile(input.category === "custom" ? input.customQuery ?? "" : input.term);
  const q = validateCompiledQuery(compiled.query);
  if (!q.ok) return q;
  return {
    ok: true as const,
    category: cat.key,
    label: compiled.label,
    inputTerm: termCheck.value,
    compiledQuery: q.value,
    recency: cat.defaultRecency,
    confirmBacklink: compiled.confirmBacklink,
    backlinkDomain: compiled.backlinkDomain,
  };
}

// -------- Create --------
export async function createAlert(input: {
  category: string;
  term: string;
  customQuery?: string;
  recency?: Recency;
  frequency?: "daily" | "hourly";
}): Promise<Ok<{ alertId: string }> | Err> {
  const auth = await requireUser();
  if (!auth.ok) return auth;
  const plan = planFromProfile(auth.plan);

  const built = build(input);
  if (!built.ok) return built;

  const svc = serviceClient();

  // Enforce the active-alert cap for the plan (paused alerts don't count).
  const { count } = await svc
    .from("alerts")
    .select("id", { count: "exact", head: true })
    .eq("owner_id", auth.userId)
    .eq("status", "active");
  if ((count ?? 0) >= MAX_ACTIVE_ALERTS[plan]) {
    return {
      ok: false,
      error: `You've reached your plan's ${MAX_ACTIVE_ALERTS[plan]} active-alert limit. Upgrade for more, or pause one.`,
    };
  }

  const frequency: "daily" | "hourly" = allowedFrequencies(plan).includes(input.frequency ?? "daily")
    ? input.frequency ?? "daily"
    : "daily";

  const { data, error } = await svc
    .from("alerts")
    .insert({
      owner_id: auth.userId,
      email: auth.email,
      category: built.category,
      label: built.label,
      input_term: built.inputTerm,
      compiled_query: built.compiledQuery,
      recency: input.recency ?? built.recency,
      frequency,
      confirm_backlink: built.confirmBacklink,
      backlink_domain: built.backlinkDomain,
      status: "active",
    })
    .select("id")
    .single();
  if (error) return { ok: false, error: error.message };

  revalidatePath("/alerts");
  return { ok: true, alertId: data.id as string };
}

// -------- Pause / resume / delete --------
export async function pauseAlert(alertId: string): Promise<Ok | Err> {
  const auth = await requireUser();
  if (!auth.ok) return auth;
  const svc = serviceClient();
  const { error } = await svc
    .from("alerts")
    .update({ status: "paused" })
    .eq("id", alertId)
    .eq("owner_id", auth.userId);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/alerts");
  return { ok: true };
}

export async function resumeAlert(alertId: string): Promise<Ok | Err> {
  const auth = await requireUser();
  if (!auth.ok) return auth;
  const plan = planFromProfile(auth.plan);
  const svc = serviceClient();

  const { count } = await svc
    .from("alerts")
    .select("id", { count: "exact", head: true })
    .eq("owner_id", auth.userId)
    .eq("status", "active");
  if ((count ?? 0) >= MAX_ACTIVE_ALERTS[plan]) {
    return { ok: false, error: `Resuming would exceed your ${MAX_ACTIVE_ALERTS[plan]}-alert limit.` };
  }
  const { error } = await svc
    .from("alerts")
    .update({ status: "active" })
    .eq("id", alertId)
    .eq("owner_id", auth.userId);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/alerts");
  return { ok: true };
}

export async function deleteAlert(alertId: string): Promise<Ok | Err> {
  const auth = await requireUser();
  if (!auth.ok) return auth;
  const svc = serviceClient();
  const { error } = await svc.from("alerts").delete().eq("id", alertId).eq("owner_id", auth.userId);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/alerts");
  return { ok: true };
}

// -------- Instant test run (PRD P1 → promoted, the key activation lever) --------
export async function testRunAlert(input: {
  category: string;
  term: string;
  customQuery?: string;
}): Promise<Ok<{ results: SerpResult[] }> | Err> {
  const auth = await requireUser();
  if (!auth.ok) return auth;
  const plan = planFromProfile(auth.plan);

  const built = build(input);
  if (!built.ok) return built;

  // A test run costs one SERP call — debit the budget so it can't be abused
  // as a free search proxy.
  const svc = serviceClient();
  const { data: reserved } = await svc.rpc("consume_alert_serp_budget", {
    p_owner: auth.userId,
    p_count: 1,
    p_cap: SERP_CALLS_PER_MONTH[plan],
  });
  if (!reserved) {
    return { ok: false, error: "You've used this month's search budget. It resets on your renewal date." };
  }

  const preview = await previewAlert({ query: built.compiledQuery, recency: built.recency });
  if (!preview.ok) return { ok: false, error: preview.error ?? "Search failed. Try again." };
  return { ok: true, results: preview.results };
}

// -------- Email-only signup (double opt-in via magic link) --------
// Sends a magic link; the pending alert rides in the redirect so it's created
// after the user confirms. Unconfirmed emails receive nothing further.
export async function requestAlertSignup(input: {
  email: string;
  category: string;
  term: string;
}): Promise<Ok<{ needsConfirmation: true }> | Err> {
  const email = (input.email ?? "").trim().toLowerCase();
  if (!isValidEmail(email)) return { ok: false, error: "Enter a valid email address." };
  if (isDisposableEmail(email)) {
    return { ok: false, error: "Please use a permanent email address." };
  }
  if (!getCategory(input.category)) return { ok: false, error: "Pick a category." };
  const termCheck = validateTerm(input.term);
  if (!termCheck.ok) return termCheck;

  const next = `/alerts?new=${encodeURIComponent(input.category)}&term=${encodeURIComponent(termCheck.value)}`;
  const supabase = await createClient();
  // Supabase Auth rate-limits OTP sends per email/IP — satisfies the P0
  // per-IP signup throttle without a bespoke limiter.
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      shouldCreateUser: true,
      emailRedirectTo: `${siteOrigin()}/auth/callback?next=${encodeURIComponent(next)}`,
    },
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true, needsConfirmation: true };
}
