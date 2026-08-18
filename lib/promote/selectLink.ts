// Pick the next link a Promote list should post, honouring its blend.
//
// The old rule was one line: the least recently promoted enabled link. That is
// still the rule *within* an ownership class — it is what keeps a single link
// from dominating — but which class to draw from is now a blend decision.

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  chooseOwnership,
  parseFallback,
  parseMix,
  type BlendDecision,
  type Ownership,
  OWNERSHIPS,
} from "@/lib/promote/blend";

// How many recent posts the ratio is measured over. Long enough to be a ratio,
// short enough that changing the mix takes effect within a day of posting.
const BLEND_WINDOW = 50;

export type SelectableLink = {
  id: string;
  url: string;
  title: string | null;
  angle: string | null;
  summary: string | null;
  source_name: string | null;
  ownership: Ownership;
  source_id: string | null;
  times_promoted: number | null;
};

export type LinkSelection = {
  link: SelectableLink | null;
  decision: BlendDecision;
};

type ListLike = {
  id: string;
  source_mix?: unknown;
  fallback_policy?: unknown;
};

/**
 * Choose the next link for a list. Returns the blend decision alongside it so
 * the caller can record *why* this link was picked.
 */
export async function selectNextLink(
  supabase: SupabaseClient<any>,
  list: ListLike,
  now: Date = new Date(),
): Promise<LinkSelection> {
  const mix = parseMix(list.source_mix);
  const fallback = parseFallback(list.fallback_policy);

  // What the list has actually posted lately, per class.
  const { data: recent } = await supabase
    .from("promo_post")
    .select("ownership")
    .eq("list_id", list.id)
    .in("status", ["posted", "pending"])
    .order("created_at", { ascending: false })
    .limit(BLEND_WINDOW);

  const posted: Partial<Record<Ownership, number>> = {};
  for (const row of (recent ?? []) as Array<{ ownership: string | null }>) {
    // Posts made before sources existed carry no ownership; they were all the
    // user's own hand-pasted links, so they count as owned.
    const key = (row.ownership ?? "owned") as Ownership;
    if (OWNERSHIPS.includes(key)) posted[key] = (posted[key] ?? 0) + 1;
  }

  // The best candidate in each class: least recently promoted first, so the
  // rotation stays fair inside the class.
  const candidates: Partial<Record<Ownership, SelectableLink>> = {};
  const available: Partial<Record<Ownership, boolean>> = {};
  await Promise.all(
    OWNERSHIPS.map(async (ownership) => {
      const { data } = await supabase
        .from("promo_link")
        .select(
          "id, url, title, angle, summary, source_name, ownership, source_id, times_promoted",
        )
        .eq("list_id", list.id)
        .eq("enabled", true)
        .eq("ownership", ownership)
        .order("last_promoted_at", { ascending: true, nullsFirst: true })
        .limit(1);
      const row = (data ?? [])[0] as SelectableLink | undefined;
      if (row) {
        candidates[ownership] = row;
        available[ownership] = true;
      }
    }),
  );

  // Which classes this campaign has an enabled source feeding. A class with no
  // source and no links is not starved — it is simply not part of the mix, and
  // treating it as starved turns every ordinary post into a fallback.
  const { data: sourceRows } = await supabase
    .from("promo_source")
    .select("ownership")
    .eq("list_id", list.id)
    .eq("enabled", true);

  const hasSource: Partial<Record<Ownership, boolean>> = {};
  for (const row of (sourceRows ?? []) as Array<{ ownership: string }>) {
    const key = row.ownership as Ownership;
    if (OWNERSHIPS.includes(key)) hasSource[key] = true;
  }

  const fallbackUsedToday = await countFallbackToday(supabase, list.id, now);

  const decision = chooseOwnership({
    mix,
    posted,
    available,
    hasSource,
    fallback,
    fallbackUsedToday,
  });

  return {
    link: decision.ownership ? (candidates[decision.ownership] ?? null) : null,
    decision,
  };
}

async function countFallbackToday(
  supabase: SupabaseClient<any>,
  listId: string,
  now: Date,
): Promise<number> {
  // A rolling 24 hours rather than a calendar day: the list has a timezone but
  // the cap is about pacing, and a rolling window cannot be gamed by a
  // midnight boundary.
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const { count } = await supabase
    .from("promo_post")
    .select("id", { count: "exact", head: true })
    .eq("list_id", listId)
    .eq("via_fallback", true)
    .gte("created_at", since);
  return count ?? 0;
}
