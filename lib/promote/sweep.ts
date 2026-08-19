// Promote sweep: processes due promo_lists, picks the next link, plans a
// durable job per intended publication, generates a fresh pitch via LLM,
// publishes via the sp platform layer, debits 1 credit per post, and advances
// the scheduler.
//
// The job layer (lib/promote/jobs.ts) is what makes a publication happen at
// most once. This sweep runs on a 60s interval *and* out-of-band whenever a
// user clicks "Post now", so two runs racing the same campaign is normal. They
// now converge: both derive the same idempotency key for the same slot, one
// insert wins, and only the worker that wins the claim publishes.

import type { SupabaseClient } from "@supabase/supabase-js";
import type Anthropic from "@anthropic-ai/sdk";
import type OpenAI from "openai";
import { generatePitch } from "@/lib/promote/generatePitch";
import { selectNextLink } from "@/lib/promote/selectLink";
import type { Ownership } from "@/lib/promote/blend";
import {
  claimJob,
  planJobs,
  recordJobBody,
  settleJob,
  type PlanJobInput,
} from "@/lib/promote/jobs";
import { postViaAccount, type PostResult } from "@/lib/sp/post";

export type PromoteSweepClients = {
  anthropic: Anthropic | null;
  openai: OpenAI | null;
};

export type PromoteSweepResult = {
  listsProcessed: number;
  jobsPlanned: number;
  postsAttempted: number;
  postsSucceeded: number;
  postsFailed: number;
  // Cookie-auth posts enqueued this sweep but not yet published (reconciled
  // later by the worker).
  postsPending: number;
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
  // The due time this sweep observed. It is the scheduling slot every job
  // planned this tick is keyed on, so a racing sweep keys on the same one.
  next_run_at: string;
  source_mix?: unknown;
  fallback_policy?: unknown;
};

type PromoLink = {
  id: string;
  url: string;
  title: string | null;
  angle: string | null;
  summary?: string | null;
  source_name?: string | null;
  source_id?: string | null;
  ownership?: Ownership | null;
  times_promoted?: number | null;
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
    jobsPlanned: 0,
    postsAttempted: 0,
    postsSucceeded: 0,
    postsFailed: 0,
    postsPending: 0,
    listsPaused: 0,
  };

  const { data: lists, error } = await supabase
    .from("promo_list")
    .select(
      "id, user_id, name, cadence_seconds, post_mode, target_account_ids, brand_voice, quiet_start, quiet_end, timezone, next_run_at, source_mix, fallback_policy",
    )
    .eq("status", "running")
    .lte("next_run_at", new Date().toISOString())
    .order("next_run_at", { ascending: true })
    .limit(limit);

  if (error || !lists || lists.length === 0) return result;

  // Claim each due list by pushing next_run_at forward, conditional on it not
  // having moved since we read it. The predicate is the point: without it this
  // is a read-then-write and an overlapping sweep wins the same list. Only the
  // lists whose update matched a row are ours to process.
  //
  // This is an optimization, not the safety property — it saves duplicated
  // work. The guarantee that nothing publishes twice lives in the job's
  // idempotency key and claim, one level down.
  const claimed = await Promise.all(
    (lists as PromoList[]).map(async (l) => {
      const { data } = await supabase
        .from("promo_list")
        .update({
          next_run_at: new Date(Date.now() + l.cadence_seconds * 1000).toISOString(),
        })
        .eq("id", l.id)
        .eq("next_run_at", l.next_run_at)
        .select("id");
      return (data ?? []).length > 0 ? l : null;
    }),
  );

  for (const list of claimed.filter((l): l is PromoList => l !== null)) {
    try {
      const r = await processOneList(supabase, list, clients);
      result.listsProcessed++;
      result.jobsPlanned += r.planned;
      result.postsAttempted += r.attempted;
      result.postsSucceeded += r.succeeded;
      result.postsFailed += r.failed;
      result.postsPending += r.pending;
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
): Promise<{
  planned: number;
  attempted: number;
  succeeded: number;
  failed: number;
  pending: number;
  paused: boolean;
}> {
  const out = {
    planned: 0,
    attempted: 0,
    succeeded: 0,
    failed: 0,
    pending: 0,
    paused: false,
  };

  // Resolve accounts
  const accounts = await resolveAccounts(supabase, list);
  if (accounts.length === 0) {
    // No accounts connected — skip and bump
    await advanceScheduler(supabase, list);
    return out;
  }

  // Pick the next link. Within an ownership class this is still
  // least-recently-promoted-first round-robin; which class to draw from is the
  // list's blend decision (70% our content, 30% industry content, and so on).
  const selection = await selectNextLink(supabase, list);
  if (!selection.link) {
    // Nothing eligible: an empty list, or a blend whose target class is starved
    // and whose fallback policy says not to cover for it. Either way this is a
    // quiet no-op, not a failure — the next tick tries again.
    if (selection.decision.reason !== "no_inventory") {
      console.log(
        `[promote] list ${list.id} skipped a tick: ${selection.decision.reason}`,
      );
    }
    await advanceScheduler(supabase, list);
    return out;
  }

  const link = selection.link as PromoLink;
  const ownership: Ownership = (link.ownership ?? "owned") as Ownership;
  const viaFallback = selection.decision.viaFallback;

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

  // Write down what we intend to publish, before publishing any of it. A
  // racing sweep that reached the same decision derives the same idempotency
  // keys and gets nothing back here, so it publishes nothing.
  const plans: PlanJobInput[] = postTargets.map(({ link: targetLink, account }) => ({
    userId: list.user_id,
    listId: list.id,
    linkId: targetLink.id,
    accountId: account.id,
    platform: account.platform,
    resolvedUrl: targetLink.url,
    resolvedTitle: targetLink.title,
    ownership,
    sourceId: targetLink.source_id ?? null,
    viaFallback,
    slotAt: list.next_run_at,
  }));

  const jobs = await planJobs(supabase, plans);
  out.planned = jobs.length;

  if (jobs.length === 0) {
    // Either another sweep already owns this slot, or the job table could not
    // be written (planJobs has already said which, loudly). Nothing to do, and
    // in particular nothing to publish.
    await advanceScheduler(supabase, list);
    return out;
  }

  const accountsById = new Map(accounts.map((a) => [a.id, a]));

  for (const [index, job] of jobs.entries()) {
    const account = accountsById.get(job.account_id);
    if (!account) {
      // The account was disconnected between resolve and plan. Close the job
      // rather than leaving it queued: nothing reclaims a queued job, so it
      // would sit there forever misrepresenting the campaign as backed up.
      await settleJob(supabase, job.id, {
        state: "cancelled",
        error: "connected account is no longer available",
      });
      continue;
    }

    // Take the job. Nothing below this line runs twice for the same job, and
    // nothing above it published anything.
    if (!(await claimJob(supabase, job))) continue;

    // Check credits before each post
    const { data: hasCredit } = await supabase.rpc("consume_credit", {
      p_owner: list.user_id,
      p_count: 1,
    });

    if (!hasCredit) {
      // Insufficient credits — auto-pause. Cancel this job and every one still
      // queued behind it, so a paused campaign does not leave a tick's worth of
      // jobs stranded in 'queued' with nothing that will ever claim them.
      for (const stranded of jobs.slice(index)) {
        await settleJob(supabase, stranded.id, {
          state: "cancelled",
          error: "insufficient_credits",
        });
      }
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
        .eq("link_id", job.link_id)
        .eq("platform", account.platform)
        .eq("status", "posted")
        .order("created_at", { ascending: false })
        .limit(5);

      const recentBodies = (recentPitches ?? []).map(
        (p: any) => p.body as string,
      );

      // Generate a fresh pitch
      const pitch = await generatePitch({
        url: job.resolved_url,
        title: job.resolved_title,
        angle: link.angle,
        platform: account.platform,
        brandVoice: list.brand_voice,
        recentBodies,
        anthropic: clients.anthropic,
        openai: clients.openai,
        summary: link.summary ?? null,
        sourceName: link.source_name ?? null,
        ownership: job.ownership,
      });

      // Freeze the copy on the job before it goes out, so a job interrupted
      // during publish can be read back and shows exactly what was sent.
      await recordJobBody(supabase, job.id, pitch.body);

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

      // Cookie-auth posts (reddit/instagram/mastodon/x/linkedin/facebook/threads)
      // are only *enqueued* here — the Playwright worker publishes later. Record
      // them as 'pending' with a link to the sp_post so the worker can reconcile
      // the real URL/status (and refund on failure). Only synchronous API posts
      // (bluesky/telegram/discord + OAuth reddit/mastodon) are 'posted' now.
      const isPending = postResult.ok && postResult.pending === true;
      const { data: inserted } = await supabase
        .from("promo_post")
        .insert({
          list_id: list.id,
          link_id: job.link_id,
          account_id: account.id,
          platform: account.platform,
          ownership: job.ownership,
          source_id: job.source_id,
          via_fallback: job.via_fallback,
          body: pitch.body,
          provider: pitch.provider,
          model: pitch.model,
          status: !postResult.ok ? "failed" : isPending ? "pending" : "posted",
          external_post_id: postResult.ok && !isPending ? postResult.platformPostId : null,
          post_url: postResult.ok && !isPending ? postResult.webUrl || null : null,
          error: postResult.ok ? null : postResult.error,
          credits_spent: 1,
          posted_at: postResult.ok && !isPending ? new Date().toISOString() : null,
          sp_post_id: postResult.ok && isPending ? postResult.postId : null,
        })
        .select("id")
        .maybeSingle();

      const promoPostId = (inserted as { id?: string } | null)?.id ?? null;

      if (!postResult.ok) {
        out.failed++;
        await settleJob(supabase, job.id, {
          state: "failed",
          error: postResult.error ?? "publish failed",
          promoPostId,
        });
        // Synchronous failure — refund the credit now. (Async cookie failures
        // are refunded later by reconcilePromo in the worker.)
        await supabase.rpc("consume_credit", {
          p_owner: list.user_id,
          p_count: -1,
        });
      } else {
        // A pending cookie-auth post has been handed to the browser worker, so
        // as far as this job is concerned the publish happened: the job must
        // not be re-run. reconcilePromo settles the promo_post later.
        await settleJob(supabase, job.id, { state: "published", promoPostId });
        if (isPending) out.pending++;
        else out.succeeded++;
      }
    } catch (err) {
      out.failed++;
      const message = err instanceof Error ? err.message : "Unknown error";

      // Record the failed post
      const { data: inserted } = await supabase
        .from("promo_post")
        .insert({
          list_id: list.id,
          link_id: job.link_id,
          account_id: account.id,
          platform: account.platform,
          ownership: job.ownership,
          source_id: job.source_id,
          via_fallback: job.via_fallback,
          body: `[generation failed: ${message}]`,
          status: "failed",
          error: message,
          credits_spent: 0,
        })
        .select("id")
        .maybeSingle();

      await settleJob(supabase, job.id, {
        state: "failed",
        error: message,
        promoPostId: (inserted as { id?: string } | null)?.id ?? null,
      });

      // Refund credit
      await supabase.rpc("consume_credit", {
        p_owner: list.user_id,
        p_count: -1,
      });
    }
  }

  // Update the link's round-robin cursor. times_promoted is a real counter now
  // that selection reads it back — it used to be re-stamped to 1 every tick,
  // because the old query never selected the column it was incrementing.
  await supabase
    .from("promo_link")
    .update({
      last_promoted_at: new Date().toISOString(),
      times_promoted: (link.times_promoted ?? 0) + 1,
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
