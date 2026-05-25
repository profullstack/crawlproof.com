import type { SupabaseClient } from "@supabase/supabase-js";

export const LX_STUCK_AFTER_MS = 10 * 60 * 1000;

export type LxRepairResult = {
  publishingArticles: number;
  generatingKeywordsWithArticle: number;
  generatingKeywordsRequeued: number;
  generatingGuestRequests: number;
};

export async function repairStuckLxJobs(
  supabase: SupabaseClient<any>,
  opts: { siteId?: string; now?: Date } = {},
): Promise<LxRepairResult> {
  const cutoff = new Date(
    (opts.now ?? new Date()).getTime() - LX_STUCK_AFTER_MS,
  ).toISOString();

  let articleQuery = supabase
    .from("lx_article")
    .update({
      status: "ready",
      webhook_last_error: "recovered from stuck publishing",
    })
    .eq("status", "publishing")
    .lt("updated_at", cutoff);
  if (opts.siteId) articleQuery = articleQuery.eq("site_id", opts.siteId);
  const { data: stuckArticles, error: artErr } = await articleQuery.select("id");
  if (artErr) console.warn("[lx repair] articles", artErr.message);

  let publishedKeywordQuery = supabase
    .from("lx_keyword")
    .update({ status: "published" })
    .eq("status", "generating")
    .not("article_id", "is", null);
  if (opts.siteId) publishedKeywordQuery = publishedKeywordQuery.eq("site_id", opts.siteId);
  const { data: keywordsWithArticle, error: kwArticleErr } =
    await publishedKeywordQuery.select("id");
  if (kwArticleErr) console.warn("[lx repair] keywords with article", kwArticleErr.message);

  let requeueKeywordQuery = supabase
    .from("lx_keyword")
    .update({ status: "queued" })
    .eq("status", "generating")
    .is("article_id", null)
    .lt("updated_at", cutoff);
  if (opts.siteId) requeueKeywordQuery = requeueKeywordQuery.eq("site_id", opts.siteId);
  const { data: stuckKeywords, error: kwErr } = await requeueKeywordQuery.select("id");
  if (kwErr) console.warn("[lx repair] keywords", kwErr.message);

  let guestQuery = supabase
    .from("lx_guest_post_request")
    .update({ status: "queued", error_text: null })
    .eq("status", "generating")
    .lt("updated_at", cutoff);
  if (opts.siteId) guestQuery = guestQuery.eq("author_site_id", opts.siteId);
  const { data: stuckGuestRequests, error: guestErr } = await guestQuery.select("id");
  if (guestErr) console.warn("[lx repair] guest requests", guestErr.message);

  return {
    publishingArticles: stuckArticles?.length ?? 0,
    generatingKeywordsWithArticle: keywordsWithArticle?.length ?? 0,
    generatingKeywordsRequeued: stuckKeywords?.length ?? 0,
    generatingGuestRequests: stuckGuestRequests?.length ?? 0,
  };
}
