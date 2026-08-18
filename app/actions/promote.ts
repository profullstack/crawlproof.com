"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { serviceClient } from "@/lib/supabase/service";
import { parseLinks, fetchLinkTitle } from "@/lib/promote/generatePitch";
import { parseKeywords } from "@/lib/promote/keywords";
import {
  addKeywordSources as addKeywordSourcesToList,
  ensureFeed,
  normalizeFeedUrl,
  validateFeedUrl,
  type KeywordSourceOutcome,
} from "@/lib/promote/sources";
import { fanOutToSubscribers, ingestFeedNow } from "@/lib/promote/ingest";
import { parseFallback, parseMix, type Ownership } from "@/lib/promote/blend";
import { env } from "@/lib/env";

type Ok<T = Record<string, unknown>> = { ok: true } & T;
type Err = { ok: false; error: string };

async function requireUser(): Promise<
  { ok: true; userId: string; email: string } | Err
> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };
  return { ok: true, userId: user.id, email: user.email ?? "" };
}

// -------- Create a promote list --------
export async function createPromoteList(input: {
  name: string;
  links: string;
  cadenceSeconds: number;
  postMode: "trickle" | "burst";
  brandVoice: string;
  targetAccountIds: string[] | null;
}): Promise<Ok<{ listId: string }> | Err> {
  const auth = await requireUser();
  if (!auth.ok) return auth;

  const name = (input.name ?? "").trim() || "Promote list";
  const urls = parseLinks(input.links);
  if (urls.length === 0) {
    return { ok: false, error: "Paste at least one valid URL." };
  }
  if (urls.length > 200) {
    return { ok: false, error: "Maximum 200 links per list." };
  }

  const cadence = input.cadenceSeconds;
  if (cadence < 300 || cadence > 604800) {
    return { ok: false, error: "Cadence must be between 5 minutes and 7 days." };
  }

  const svc = serviceClient();

  // Create the list
  const { data: list, error: listErr } = await svc
    .from("promo_list")
    .insert({
      user_id: auth.userId,
      name,
      status: "running",
      cadence_seconds: cadence,
      post_mode: input.postMode ?? "trickle",
      brand_voice: input.brandVoice?.trim() || null,
      target_account_ids: input.targetAccountIds,
      next_run_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (listErr || !list) {
    return { ok: false, error: listErr?.message ?? "Could not create list." };
  }

  // Insert links (fetch titles in the background — don't block the response)
  const linkRows = urls.map((url) => ({
    list_id: list.id,
    url,
    enabled: true,
  }));
  const { error: linksErr } = await svc.from("promo_link").insert(linkRows);
  if (linksErr) {
    // Clean up the list if links failed
    await svc.from("promo_list").delete().eq("id", list.id);
    return { ok: false, error: linksErr.message };
  }

  // Best-effort title fetching (non-blocking)
  fetchTitlesForList(list.id, urls).catch(() => {});

  revalidatePath("/dashboard/promote");
  return { ok: true, listId: list.id as string };
}

// Background title fetcher
async function fetchTitlesForList(listId: string, urls: string[]) {
  const svc = serviceClient();
  for (const url of urls.slice(0, 50)) {
    try {
      const title = await fetchLinkTitle(url);
      if (title) {
        await svc
          .from("promo_link")
          .update({ title })
          .eq("list_id", listId)
          .eq("url", url);
      }
    } catch {
      // ignore
    }
  }
}

// -------- Update a promote list --------
export async function updatePromoteList(input: {
  listId: string;
  name: string;
  cadenceSeconds: number;
  postMode: "trickle" | "burst";
  brandVoice: string;
  targetAccountIds: string[] | null;
}): Promise<Ok | Err> {
  const auth = await requireUser();
  if (!auth.ok) return auth;

  const svc = serviceClient();
  const { error } = await svc
    .from("promo_list")
    .update({
      name: input.name.trim() || "Promote list",
      cadence_seconds: input.cadenceSeconds,
      post_mode: input.postMode ?? "trickle",
      brand_voice: input.brandVoice?.trim() || null,
      target_account_ids: input.targetAccountIds,
    })
    .eq("id", input.listId)
    .eq("user_id", auth.userId);
  if (error) return { ok: false, error: error.message };

  revalidatePath("/dashboard/promote");
  revalidatePath(`/dashboard/promote/${input.listId}`);
  return { ok: true };
}

// -------- Add links to an existing list --------
export async function addLinksToList(input: {
  listId: string;
  links: string;
}): Promise<Ok<{ added: number }> | Err> {
  const auth = await requireUser();
  if (!auth.ok) return auth;

  const urls = parseLinks(input.links);
  if (urls.length === 0) {
    return { ok: false, error: "Paste at least one valid URL." };
  }

  const svc = serviceClient();

  // Verify ownership
  const { data: list } = await svc
    .from("promo_list")
    .select("id")
    .eq("id", input.listId)
    .eq("user_id", auth.userId)
    .maybeSingle();
  if (!list) return { ok: false, error: "List not found." };

  const linkRows = urls.map((url) => ({
    list_id: input.listId,
    url,
    enabled: true,
  }));
  // Use upsert to skip duplicates (unique on list_id, url)
  const { error, count } = await svc
    .from("promo_link")
    .upsert(linkRows, { onConflict: "list_id,url", ignoreDuplicates: true, count: "exact" });
  if (error) return { ok: false, error: error.message };

  // Best-effort title fetching
  fetchTitlesForList(input.listId, urls).catch(() => {});

  revalidatePath(`/dashboard/promote/${input.listId}`);
  return { ok: true, added: count ?? urls.length };
}

// ============================================================
// Content sources
// ============================================================

async function ownedList(listId: string, userId: string): Promise<boolean> {
  const svc = serviceClient();
  const { data } = await svc
    .from("promo_list")
    .select("id")
    .eq("id", listId)
    .eq("user_id", userId)
    .maybeSingle();
  return Boolean(data);
}

/**
 * Add one source per keyword. "bitcoin, blockchain" becomes two RSS Amplifier
 * topic sources, never one combined feed.
 */
export async function addKeywordSources(input: {
  listId: string;
  keywords: string;
  ownership?: Ownership;
}): Promise<Ok<{ results: KeywordSourceOutcome[]; added: number }> | Err> {
  const auth = await requireUser();
  if (!auth.ok) return auth;
  if (!(await ownedList(input.listId, auth.userId))) {
    return { ok: false, error: "List not found." };
  }

  const keywords = parseKeywords(input.keywords);
  if (keywords.length === 0) return { ok: false, error: "Enter at least one keyword." };
  if (keywords.length > 25) {
    return { ok: false, error: "Add at most 25 keywords at a time." };
  }

  const svc = serviceClient();
  const results = await addKeywordSourcesToList(svc, {
    listId: input.listId,
    keywords,
    // Keyword sources are other people's writing by default.
    ownership: input.ownership ?? "shared",
  });

  // Backfill each new source now, so the campaign has something to post
  // without waiting for the next ingestion tick.
  for (const result of results) {
    if (!result.ok || !result.feedId) continue;
    try {
      await ingestFeedNow(svc, result.feedId);
      await fanOutToSubscribers(svc, result.feedId, new Date(), result.sourceId);
    } catch {
      // The worker retries on its own schedule; a slow feed is not a failure
      // to add the source.
    }
  }

  revalidatePath(`/dashboard/promote/${input.listId}`);
  return { ok: true, results, added: results.filter((r) => r.ok).length };
}

/** Add a single RSS or Atom feed the user owns or follows. */
export async function addFeedSource(input: {
  listId: string;
  feedUrl: string;
  ownership?: Ownership;
  label?: string;
}): Promise<Ok<{ sourceId: string; title: string | null }> | Err> {
  const auth = await requireUser();
  if (!auth.ok) return auth;
  if (!(await ownedList(input.listId, auth.userId))) {
    return { ok: false, error: "List not found." };
  }

  const normalized = normalizeFeedUrl(input.feedUrl);
  if (!normalized.ok) return { ok: false, error: normalized.error };

  const validation = await validateFeedUrl(normalized.url);
  if (!validation.ok) return { ok: false, error: validation.error };

  const svc = serviceClient();
  const feed = await ensureFeed(svc, {
    feedUrl: validation.feedUrl,
    kind: "custom_feed",
    title: validation.title,
  });
  if (!feed) return { ok: false, error: "Could not register that feed." };

  const { data: source, error } = await svc
    .from("promo_source")
    .insert({
      list_id: input.listId,
      feed_id: feed.id,
      type: "custom_feed",
      // A feed the user went out of their way to add is usually their own.
      ownership: input.ownership ?? "owned",
      label: (input.label ?? "").trim() || validation.title || validation.feedUrl,
    })
    .select("id")
    .single();

  if (error || !source) {
    return { ok: false, error: "This campaign already tracks that feed." };
  }

  try {
    await ingestFeedNow(svc, feed.id);
    await fanOutToSubscribers(svc, feed.id, new Date(), source.id as string);
  } catch {
    // Ingestion retries on the worker's schedule.
  }

  revalidatePath(`/dashboard/promote/${input.listId}`);
  return { ok: true, sourceId: source.id as string, title: validation.title };
}

/** Turn a source off without losing the links it has already contributed. */
export async function toggleSource(sourceId: string, enabled: boolean): Promise<Ok | Err> {
  const auth = await requireUser();
  if (!auth.ok) return auth;
  const svc = serviceClient();

  const { data: source } = await svc
    .from("promo_source")
    .select("id, list_id, promo_list!inner(user_id)")
    .eq("id", sourceId)
    .maybeSingle();
  if (!source) return { ok: false, error: "Source not found." };
  if ((source as any).promo_list?.user_id !== auth.userId) {
    return { ok: false, error: "Not authorized." };
  }

  const { error } = await svc.from("promo_source").update({ enabled }).eq("id", sourceId);
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/dashboard/promote/${source.list_id}`);
  return { ok: true };
}

/**
 * Remove a source. Links it already imported stay: they are in the rotation,
 * and silently deleting posts a user has seen queued would be a surprise.
 * promo_link.source_id is ON DELETE SET NULL for exactly this reason.
 */
export async function removeSource(sourceId: string): Promise<Ok | Err> {
  const auth = await requireUser();
  if (!auth.ok) return auth;
  const svc = serviceClient();

  const { data: source } = await svc
    .from("promo_source")
    .select("id, list_id, promo_list!inner(user_id)")
    .eq("id", sourceId)
    .maybeSingle();
  if (!source) return { ok: false, error: "Source not found." };
  if ((source as any).promo_list?.user_id !== auth.userId) {
    return { ok: false, error: "Not authorized." };
  }

  const { error } = await svc.from("promo_source").delete().eq("id", sourceId);
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/dashboard/promote/${source.list_id}`);
  return { ok: true };
}

/** Set the owned/partner/shared publishing ratio and the fallback policy. */
export async function updateBlend(input: {
  listId: string;
  mix: Partial<Record<Ownership, number>>;
  fallback?: Record<string, unknown>;
}): Promise<Ok | Err> {
  const auth = await requireUser();
  if (!auth.ok) return auth;

  const mix = parseMix(input.mix);
  const total = mix.owned + mix.partner + mix.shared;
  if (total <= 0) return { ok: false, error: "At least one source group needs a weight." };

  const svc = serviceClient();
  const { error } = await svc
    .from("promo_list")
    .update({
      source_mix: mix,
      ...(input.fallback ? { fallback_policy: parseFallback(input.fallback) } : {}),
    })
    .eq("id", input.listId)
    .eq("user_id", auth.userId);
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/dashboard/promote/${input.listId}`);
  return { ok: true };
}

// -------- Remove a link --------
export async function removeLink(linkId: string): Promise<Ok | Err> {
  const auth = await requireUser();
  if (!auth.ok) return auth;

  const svc = serviceClient();
  // Verify ownership via join
  const { data: link } = await svc
    .from("promo_link")
    .select("id, list_id, promo_list!inner(user_id)")
    .eq("id", linkId)
    .maybeSingle();
  if (!link) return { ok: false, error: "Link not found." };
  const listOwner = (link as any).promo_list?.user_id;
  if (listOwner !== auth.userId) return { ok: false, error: "Not authorized." };

  const { error } = await svc.from("promo_link").delete().eq("id", linkId);
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/dashboard/promote/${link.list_id}`);
  return { ok: true };
}

// -------- Toggle link enabled --------
export async function toggleLink(linkId: string, enabled: boolean): Promise<Ok | Err> {
  const auth = await requireUser();
  if (!auth.ok) return auth;

  const svc = serviceClient();
  const { data: link } = await svc
    .from("promo_link")
    .select("id, list_id, promo_list!inner(user_id)")
    .eq("id", linkId)
    .maybeSingle();
  if (!link) return { ok: false, error: "Link not found." };
  const listOwner = (link as any).promo_list?.user_id;
  if (listOwner !== auth.userId) return { ok: false, error: "Not authorized." };

  const { error } = await svc
    .from("promo_link")
    .update({ enabled })
    .eq("id", linkId);
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/dashboard/promote/${link.list_id}`);
  return { ok: true };
}

// -------- Pause / Resume / Delete list --------
export async function pausePromoteList(listId: string): Promise<Ok | Err> {
  const auth = await requireUser();
  if (!auth.ok) return auth;
  const svc = serviceClient();
  const { error } = await svc
    .from("promo_list")
    .update({ status: "paused", pause_reason: "manual" })
    .eq("id", listId)
    .eq("user_id", auth.userId);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/dashboard/promote");
  return { ok: true };
}

export async function resumePromoteList(listId: string): Promise<Ok | Err> {
  const auth = await requireUser();
  if (!auth.ok) return auth;
  const svc = serviceClient();
  const { error } = await svc
    .from("promo_list")
    .update({
      status: "running",
      pause_reason: null,
      next_run_at: new Date().toISOString(),
    })
    .eq("id", listId)
    .eq("user_id", auth.userId);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/dashboard/promote");
  return { ok: true };
}

export async function deletePromoteList(listId: string): Promise<Ok | Err> {
  const auth = await requireUser();
  if (!auth.ok) return auth;
  const svc = serviceClient();
  const { error } = await svc
    .from("promo_list")
    .delete()
    .eq("id", listId)
    .eq("user_id", auth.userId);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/dashboard/promote");
  return { ok: true };
}

// -------- Post now (fire one tick immediately) --------
export async function postNow(listId: string): Promise<Ok | Err> {
  const auth = await requireUser();
  if (!auth.ok) return auth;
  const svc = serviceClient();
  // Make the list due now (and un-pause it). The claim step in the sweep then
  // stamps next_run_at forward so this can't double-post.
  const { error } = await svc
    .from("promo_list")
    .update({
      next_run_at: new Date().toISOString(),
      status: "running",
      pause_reason: null,
    })
    .eq("id", listId)
    .eq("user_id", auth.userId);
  if (error) return { ok: false, error: error.message };

  // Nudge the worker to run the sweep immediately instead of waiting up to 60s
  // for its periodic tick. The endpoint acks (202) and posts in the background;
  // realtime surfaces each post as it lands. If the worker URL isn't
  // configured, the periodic tick still picks it up (just slower).
  if (env.workerUrl && env.workerSecret) {
    try {
      await fetch(`${env.workerUrl}/promote/sweep`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-worker-secret": env.workerSecret },
        body: JSON.stringify({ listId }),
      });
    } catch {
      // Worker unreachable — the periodic sweep is the fallback.
    }
  }

  revalidatePath("/dashboard/promote");
  revalidatePath(`/dashboard/promote/${listId}`);
  return { ok: true };
}
