// Promote sweep: processes due promo_lists, picks the next link,
// generates a fresh pitch via LLM, publishes via the sp platform layer,
// debits 1 credit per post, and advances the scheduler.

import type { SupabaseClient } from "@supabase/supabase-js";
import type Anthropic from "@anthropic-ai/sdk";
import type OpenAI from "openai";
import { generatePitch } from "@/lib/promote/generatePitch";
import { postViaAccount, type PostResult } from "@/lib/sp/post";

export type PromoteSweepClients = {
  anthropic: Anthropic | null;
  openai: OpenAI | null;
};

export type PromoteSweepResult = {
  listsProcessed: number;
  postsAttempted: number;
  postsSucceeded: number;
  postsFailed: number;
  listsPaused: number;
};

type PromoList = {
  id: string;
  user_id: string;
  name: string;
  cadence_seconds: number;
  post_mode: "trickle" | "burst";
  target_account_ids: string[] | null;
  brand_voice: string | null;
  quiet_start: number | null;
  quiet_end: number | null;
  timezone: string | null;
};

type PromoLink = {
  id: string;
  url: string;
  title: string | null;
  angle: string | null;
};

type SpAccount = {
  id: string;
  platform: string;
  status: string;
  handle: string;
};

/**
 * Main sweep entry point. Called by the worker on a 60s interval.
 * Selects all promo_lists where status='running' and next_run_at <= now(),
 * then processes each.
 */
export async function processDuePromoteLists(
  supabase: SupabaseClient<any>,
  clients: PromoteSweepClients,
  limit = 10,
): Promise<PromoteSweepResult> {
  const result: PromoteSweepResult = {
    listsProcessed: 0,
    postsAttempted: 0,
    postsSucceeded: 0,
    postsFailed: 0,
    listsPaused: 0,
  };

  const { data: lists, error } = await supabase
    .from("promo_list")
    .select(
      "id, user_id, name, cadence_seconds, post_mode, target_account_ids, brand_voice, quiet_start, quiet_end, timezone",
    )
    .eq("status", "running")
    .lte("next_run_at", new Date().toISOString())
    .order("next_run_at", { ascending: true })
    .limit(limit);

  if (error || !lists || lists.length === 0) return result;

  // Claim each due list by pushing next_run_at forward before processing, so an
  // overlapping sweep (e.g. the periodic tick racing a manual "Post now"
  // trigger) can't pick up the same list and double-post. advanceScheduler
  // re-stamps next_run_at at the end of a successful run.
  await Promise.all(
    (lists as PromoList[]).map((l) =>
      supabase
        .from("promo_list")
        .update({ next_run_at: new Date(Date.now() + l.cadence_seconds * 1000).toISOString() })
        .eq("id", l.id),
    ),
  );

  for (const list of lists as PromoList[]) {
    try {
      const r = await processOneList(supabase, list, clients);
      result.listsProcessed++;
      result.postsAttempted += r.attempted;
      result.postsSucceeded += r.succeeded;
      result.postsFailed += r.failed;
      if (r.paused) result.listsPaused++;
    } catch (err) {
      console.error(
        `[promote] unhandled error processing list ${list.id}:`,
        err,
      );
      // Bump next_run_at to avoid tight-loop on broken lists
      await supabase
        .from("promo_list")
        .update({
          next_run_at: new Date(
            Date.now() + list.cadence_seconds * 1000,
          ).toISOString(),
        })
        .eq("id", list.id);
    }
  }

  return result;
}

async function processOneList(
  supabase: SupabaseClient<any>,
  list: PromoList,
  clients: PromoteSweepClients,
): Promise<{ attempted: number; succeeded: number; failed: number; paused: boolean }> {
  const out = { attempted: 0, succeeded: 0, failed: 0, paused: false };

  // Resolve accounts
  const accounts = await resolveAccounts(supabase, list);
  if (accounts.length === 0) {
    // No accounts connected — skip and bump
    await advanceScheduler(supabase, list);
    return out;
  }

  // Pick the next link(s) using round-robin (least-recently-promoted first)
  const { data: links } = await supabase
    .from("promo_link")
    .select("id, url, title, angle")
    .eq("list_id", list.id)
    .eq("enabled", true)
    .order("last_promoted_at", { ascending: true, nullsFirst: true })
    .limit(1);

  if (!links || links.length === 0) {
    await advanceScheduler(supabase, list);
    return out;
  }

  const link = links[0] as PromoLink;

  // Determine which (link, account) pairs to post this tick
  const postTargets: Array<{ link: PromoLink; account: SpAccount }> = [];
  if (list.post_mode === "burst") {
    // Burst: post to every account this tick
    for (const account of accounts) {
      postTargets.push({ link, account });
    }
  } else {
    // Trickle: one post per tick, round-robin accounts
    // Pick the account that was least recently used for this list
    const { data: recentPosts } = await supabase
      .from("promo_post")
      .select("account_id")
      .eq("list_id", list.id)
      .eq("status", "posted")
      .order("posted_at", { ascending: false })
      .limit(accounts.length);

    const recentAccountIds = new Set(
      (recentPosts ?? []).map((p: any) => p.account_id as string),
    );
    // Pick first account not recently used, or the first one
    const nextAccount =
      accounts.find((a) => !recentAccountIds.has(a.id)) ?? accounts[0];
    postTargets.push({ link, account: nextAccount });
  }

  for (const { link: targetLink, account } of postTargets) {
    // Check credits before each post
    const { data: hasCredit } = await supabase.rpc("consume_credit", {
      p_owner: list.user_id,
      p_count: 1,
    });

    if (!hasCredit) {
      // Insufficient credits — auto-pause
      await supabase
        .from("promo_list")
        .update({
          status: "paused",
          pause_reason: "insufficient_credits",
        })
        .eq("id", list.id);
      out.paused = true;
      break;
    }

    out.attempted++;

    try {
      // Fetch recent bodies for anti-repeat
      const { data: recentPitches } = await supabase
        .from("promo_post")
        .select("body")
        .eq("link_id", targetLink.id)
        .eq("platform", account.platform)
        .eq("status", "posted")
        .order("created_at", { ascending: false })
        .limit(5);

      const recentBodies = (recentPitches ?? []).map(
        (p: any) => p.body as string,
      );

      // Generate a fresh pitch
      const pitch = await generatePitch({
        url: targetLink.url,
        title: targetLink.title,
        angle: targetLink.angle,
        platform: account.platform,
        brandVoice: list.brand_voice,
        recentBodies,
        anthropic: clients.anthropic,
        openai: clients.openai,
      });

      // Publish via the existing sp platform layer
      const postResult: PostResult = await postViaAccount({
        supabase,
        userId: list.user_id,
        input: {
          accountId: account.id,
          text: pitch.body,
          title: pitch.title,
        },
        source: "manual", // reuse existing source type
      });

      // Record the promo_post
      await supabase.from("promo_post").insert({
        list_id: list.id,
        link_id: targetLink.id,
        account_id: account.id,
        platform: account.platform,
        body: pitch.body,
        provider: pitch.provider,
        model: pitch.model,
        status: postResult.ok ? "posted" : "failed",
        external_post_id: postResult.ok ? postResult.platformPostId : null,
        post_url: postResult.ok ? postResult.webUrl || null : null,
        error: postResult.ok ? null : postResult.error,
        credits_spent: 1,
        posted_at: postResult.ok ? new Date().toISOString() : null,
      });

      if (postResult.ok) {
        out.succeeded++;
      } else {
        out.failed++;
        // Refund credit on post failure
        await supabase.rpc("consume_credit", {
          p_owner: list.user_id,
          p_count: -1,
        });
      }
    } catch (err) {
      out.failed++;
      const message = err instanceof Error ? err.message : "Unknown error";

      // Record the failed post
      await supabase.from("promo_post").insert({
        list_id: list.id,
        link_id: targetLink.id,
        account_id: account.id,
        platform: account.platform,
        body: `[generation failed: ${message}]`,
        status: "failed",
        error: message,
        credits_spent: 0,
      });

      // Refund credit
      await supabase.rpc("consume_credit", {
        p_owner: list.user_id,
        p_count: -1,
      });
    }
  }

  // Update the link's round-robin cursor
  await supabase
    .from("promo_link")
    .update({
      last_promoted_at: new Date().toISOString(),
      times_promoted: (link as any).times_promoted
        ? (link as any).times_promoted + 1
        : 1,
    })
    .eq("id", link.id);

  // Advance the scheduler
  await advanceScheduler(supabase, list);

  return out;
}

async function resolveAccounts(
  supabase: SupabaseClient<any>,
  list: PromoList,
): Promise<SpAccount[]> {
  if (list.target_account_ids && list.target_account_ids.length > 0) {
    // Pinned accounts
    const { data } = await supabase
      .from("sp_account")
      .select("id, platform, status, handle")
      .in("id", list.target_account_ids)
      .eq("status", "active");
    return (data ?? []) as SpAccount[];
  }

  // All active accounts for this user
  const { data } = await supabase
    .from("sp_account")
    .select("id, platform, status, handle")
    .eq("user_id", list.user_id)
    .eq("status", "active");
  return (data ?? []) as SpAccount[];
}

async function advanceScheduler(
  supabase: SupabaseClient<any>,
  list: PromoList,
) {
  await supabase
    .from("promo_list")
    .update({
      last_run_at: new Date().toISOString(),
      next_run_at: new Date(
        Date.now() + list.cadence_seconds * 1000,
      ).toISOString(),
    })
    .eq("id", list.id);
}
