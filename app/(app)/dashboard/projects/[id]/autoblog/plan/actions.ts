"use server";

import { revalidatePath } from "next/cache";
import { getProjectById } from "@/lib/lx/currentSite";
import { serviceClient } from "@/lib/supabase/service";

const ARTICLE_TYPES = new Set([
  "",
  "guide",
  "comparison",
  "listicle",
  "alternative",
  "faq",
  "tutorial",
  "case-study",
  "glossary",
]);

function normalizeDate(input: FormDataEntryValue | null): string | null {
  const raw = String(input ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  return raw;
}

export async function updateKeywordPlan(
  projectId: string,
  keywordId: string,
  formData: FormData,
) {
  const project = await getProjectById(projectId, {
    siteColumns: "id",
    projectColumns: "id",
  });
  const site = project?.lx_site as { id?: string } | null;
  if (!site?.id) throw new Error("Autoblog is not configured for this project.");

  const scheduledFor = normalizeDate(formData.get("scheduled_for"));
  if (!scheduledFor) throw new Error("A valid scheduled date is required.");

  const articleType = String(formData.get("article_type") ?? "").trim();
  if (!ARTICLE_TYPES.has(articleType)) throw new Error("Invalid article type.");

  const customInstructions = String(formData.get("custom_instructions") ?? "")
    .trim()
    .slice(0, 4000);

  const { error } = await serviceClient()
    .from("lx_keyword")
    .update({
      scheduled_for: scheduledFor,
      article_type: articleType || null,
      custom_instructions: customInstructions || null,
    })
    .eq("id", keywordId)
    .eq("site_id", site.id)
    .in("status", ["queued", "failed"]);

  if (error) throw new Error(error.message);
  revalidatePath(`/dashboard/projects/${projectId}/autoblog/plan`);
  revalidatePath(`/dashboard/projects/${projectId}/autoblog`);
}

