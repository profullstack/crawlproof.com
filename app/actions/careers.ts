"use server";

import { revalidatePath } from "next/cache";
import { requireProjectAccess } from "@/lib/lx/currentSite";
import { createClient } from "@/lib/supabase/server";
import { serviceClient } from "@/lib/supabase/service";
import { consumeCredit, refundCredit } from "@/lib/rateLimit";
import { JOB_POSTING_CREDITS } from "@/lib/credits";
import {
  APPLICATION_STATUSES,
  JOB_STATUSES,
  type ApplicationStatus,
  type JobStatus,
  type Workplace,
  isWorkplace,
  parseLines,
  uniqueSlug,
} from "@/lib/careers/jobs";

type Ok<T = undefined> = { ok: true } & (T extends undefined ? {} : T);
type Err = { ok: false; error: string };

const MAX_TEXT = 400;
const MAX_OVERVIEW = 8000;

function clean(value: string | null | undefined, max = MAX_TEXT) {
  const text = value?.trim().replace(/\s+/g, " ").slice(0, max);
  return text || null;
}

// Flip the careers module on/off. It rides on the stats tracker, so enabling
// careers without the tracker installed would render nothing — we say so
// rather than silently succeeding.
export async function setCareersEnabled(input: {
  projectId: string;
  enabled: boolean;
}): Promise<Ok<{ enabled: boolean }> | Err> {
  const access = await requireProjectAccess(input.projectId);
  if (!access.ok) return { ok: false, error: access.error };

  if (input.enabled) {
    const { data: project } = await access.supabase
      .from("projects")
      .select("tracker_enabled")
      .eq("id", input.projectId)
      .maybeSingle();
    if (!project?.tracker_enabled) {
      return {
        ok: false,
        error: "Enable the stats tracker first — the careers widget loads through it.",
      };
    }
  }

  const patch: Record<string, unknown> = { careers_enabled: input.enabled };
  if (input.enabled) patch.careers_enabled_at = new Date().toISOString();

  const { error } = await access.supabase
    .from("projects")
    .update(patch)
    .eq("id", input.projectId);
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/dashboard/projects/${input.projectId}/stats`);
  revalidatePath(`/dashboard/projects/${input.projectId}/stats/careers`);
  return { ok: true, enabled: input.enabled };
}

export interface JobInput {
  projectId: string;
  jobId?: string;
  title: string;
  department?: string;
  location?: string;
  employmentType?: string;
  workplace?: Workplace;
  compensation?: string;
  applyUrl?: string;
  overview?: string;
  responsibilities?: string;
  qualifications?: string;
  status?: JobStatus;
  sortOrder?: number;
}

export async function saveJobPosting(input: JobInput): Promise<Ok<{ id: string }> | Err> {
  const access = await requireProjectAccess(input.projectId);
  if (!access.ok) return { ok: false, error: access.error };

  const title = clean(input.title, 200);
  if (!title) return { ok: false, error: "Give the role a title." };

  const status: JobStatus = JOB_STATUSES.includes(input.status as JobStatus)
    ? (input.status as JobStatus)
    : "draft";

  const row: Record<string, unknown> = {
    project_id: input.projectId,
    title,
    department: clean(input.department, 120),
    location: clean(input.location, 160),
    employment_type: clean(input.employmentType, 60) ?? "Full-time",
    workplace: isWorkplace(input.workplace) ? input.workplace : "onsite",
    compensation: clean(input.compensation, 160),
    apply_url: clean(input.applyUrl, 500),
    overview: input.overview?.trim().slice(0, MAX_OVERVIEW) || null,
    responsibilities: parseLines(input.responsibilities),
    qualifications: parseLines(input.qualifications),
    status,
    sort_order: Number.isFinite(input.sortOrder) ? Number(input.sortOrder) : 0,
    updated_at: new Date().toISOString(),
  };

  const { data: existing } = input.jobId
    ? await access.supabase
        .from("job_postings")
        .select("published_at, credit_charged_at")
        .eq("id", input.jobId)
        .eq("project_id", input.projectId)
        .maybeSingle()
    : { data: null };

  // published_at is the datePosted we hand to schema.org, so it must be set
  // the first time a role goes open and then left alone.
  let charge: Charge | null = null;
  if (status === "open") {
    if (!existing?.published_at) row.published_at = new Date().toISOString();
    if (!existing?.credit_charged_at) {
      const attempt = await chargeForPublish(access.supabase, input.projectId);
      if (!attempt.ok) return attempt;
      charge = attempt;
      row.credit_charged_at = new Date().toISOString();
    }
  }

  if (input.jobId) {
    const { error } = await access.supabase
      .from("job_postings")
      .update(row)
      .eq("id", input.jobId)
      .eq("project_id", input.projectId);
    if (error) {
      await refundCharge(charge);
      return { ok: false, error: error.message };
    }
    await recordCharge(charge, input.projectId, input.jobId);
    revalidateCareers(input.projectId);
    return { ok: true, id: input.jobId };
  }

  const { data: siblings } = await access.supabase
    .from("job_postings")
    .select("slug")
    .eq("project_id", input.projectId);
  const taken = (siblings ?? []).map((s) => (s as { slug: string }).slug);

  const { data, error } = await access.supabase
    .from("job_postings")
    .insert({ ...row, slug: uniqueSlug(title, taken), created_by: access.userId })
    .select("id")
    .single();
  if (error) {
    await refundCharge(charge);
    return { ok: false, error: error.message };
  }

  await recordCharge(charge, input.projectId, data.id as string);
  revalidateCareers(input.projectId);
  return { ok: true, id: data.id as string };
}

export async function setJobStatus(input: {
  projectId: string;
  jobId: string;
  status: JobStatus;
}): Promise<Ok | Err> {
  const access = await requireProjectAccess(input.projectId);
  if (!access.ok) return { ok: false, error: access.error };
  if (!JOB_STATUSES.includes(input.status)) return { ok: false, error: "Unknown status." };

  const patch: Record<string, unknown> = {
    status: input.status,
    updated_at: new Date().toISOString(),
  };

  let charge: Charge | null = null;
  if (input.status === "open") {
    const { data: existing } = await access.supabase
      .from("job_postings")
      .select("published_at, credit_charged_at")
      .eq("id", input.jobId)
      .eq("project_id", input.projectId)
      .maybeSingle();
    if (!existing?.published_at) patch.published_at = new Date().toISOString();
    // Re-opening a role that already paid is free — you buy the posting, not
    // the month it happens to be live.
    if (!existing?.credit_charged_at) {
      const attempt = await chargeForPublish(access.supabase, input.projectId);
      if (!attempt.ok) return attempt;
      charge = attempt;
      patch.credit_charged_at = new Date().toISOString();
    }
  }

  const { error } = await access.supabase
    .from("job_postings")
    .update(patch)
    .eq("id", input.jobId)
    .eq("project_id", input.projectId);
  if (error) {
    await refundCharge(charge);
    return { ok: false, error: error.message };
  }

  await recordCharge(charge, input.projectId, input.jobId);
  revalidateCareers(input.projectId);
  return { ok: true };
}

export async function deleteJobPosting(input: {
  projectId: string;
  jobId: string;
}): Promise<Ok | Err> {
  const access = await requireProjectAccess(input.projectId);
  if (!access.ok) return { ok: false, error: access.error };

  const { error } = await access.supabase
    .from("job_postings")
    .delete()
    .eq("id", input.jobId)
    .eq("project_id", input.projectId);
  if (error) return { ok: false, error: error.message };

  revalidateCareers(input.projectId);
  return { ok: true };
}

export async function setApplicationStatus(input: {
  projectId: string;
  applicationId: string;
  status: ApplicationStatus;
}): Promise<Ok | Err> {
  const access = await requireProjectAccess(input.projectId);
  if (!access.ok) return { ok: false, error: access.error };
  if (!APPLICATION_STATUSES.includes(input.status)) {
    return { ok: false, error: "Unknown status." };
  }

  const now = new Date().toISOString();
  const { error } = await access.supabase
    .from("job_applications")
    .update({
      status: input.status,
      updated_at: now,
      // Stamp the first time someone acts on it; moving back to `new` clears
      // the stamp so "untouched" stays meaningful.
      reviewed_at: input.status === "new" ? null : now,
    })
    .eq("id", input.applicationId)
    .eq("project_id", input.projectId);
  if (error) return { ok: false, error: error.message };

  revalidateCareers(input.projectId);
  return { ok: true };
}

function revalidateCareers(projectId: string) {
  revalidatePath(`/dashboard/projects/${projectId}/stats/careers`);
}

/** A credit spend that has happened but whose posting write hasn't landed yet. */
type Charge = { ok: true; ownerId: string; cost: number };

/**
 * Spend JOB_POSTING_CREDITS for a posting about to go open.
 *
 * The project owner pays, not whoever clicked Publish — a teammate publishing
 * a role shouldn't have it come out of their personal balance, and the project
 * is already the billing entity for the tracker.
 *
 * Spend first, write second, refund on write failure. The reverse order would
 * publish roles for free whenever the charge failed, which is the expensive
 * direction to be wrong in.
 */
async function chargeForPublish(
  supabase: Awaited<ReturnType<typeof createClient>>,
  projectId: string,
): Promise<Charge | Err> {
  const { data } = await supabase
    .from("projects")
    .select("owner_id")
    .eq("id", projectId)
    .maybeSingle();
  const ownerId = (data as { owner_id?: string } | null)?.owner_id;
  if (!ownerId) return { ok: false, error: "Could not find the project owner to bill." };

  const paid = await consumeCredit(ownerId, JOB_POSTING_CREDITS);
  if (!paid.ok) {
    return {
      ok: false,
      error: `Publishing a role costs ${JOB_POSTING_CREDITS} credit${
        JOB_POSTING_CREDITS === 1 ? "" : "s"
      }. Not enough balance — top up in Settings → Billing.`,
    };
  }
  return { ok: true, ownerId, cost: JOB_POSTING_CREDITS };
}

async function refundCharge(charge: Charge | null) {
  if (!charge) return;
  await refundCredit(charge.ownerId, charge.cost);
}

/** Ledger entry so a spend is explainable later. Best-effort. */
async function recordCharge(charge: Charge | null, projectId: string, jobId: string) {
  if (!charge) return;
  try {
    await serviceClient()
      .from("usage_events")
      .insert({
        owner_id: charge.ownerId,
        kind: "job_posting_published",
        meta: { project_id: projectId, job_id: jobId, credits_spent: charge.cost },
      });
  } catch {
    // A missing ledger row must never undo a successful publish.
  }
}
