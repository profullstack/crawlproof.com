// Run one Buyer Intent watch: charge the sweep, search every enabled community
// for the watch's keywords and competitor names, keep what scores, store the
// new ones, and send them where the owner asked.

import type { SupabaseClient } from "@supabase/supabase-js";
import { sweepIntent, type IntentHit } from "@/lib/outreach/intentSources";
import { spendableCredits, CREDIT_COLUMNS, type TrialProfile } from "@/lib/trial";
import { sweepNative } from "./native";
import { deliverLeads, type DeliveryResult } from "./deliver";
import {
  COMPETITOR_CALL_BUDGET,
  INTENT_SWEEP_CREDITS,
  KEYWORD_CALL_BUDGET,
  isCadence,
  leadTier,
  matchCompetitor,
  nextRunAt,
  type LeadRow,
} from "./tiers";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Svc = SupabaseClient<any>;

export type IntentWatch = {
  id: string;
  owner_id: string;
  name: string;
  sells: string | null;
  keywords: string[];
  competitors: string[];
  negative_keywords: string[];
  sources: string[];
  cadence: string;
  min_score: number;
  slack_webhook_url: string | null;
  discord_webhook_url: string | null;
  webhook_url: string | null;
  webhook_secret: string | null;
  email_digest: boolean;
  active: boolean;
};

export type RunResult =
  | { ok: true; found: number; inserted: number; calls: number; deliveries: DeliveryResult[]; notes: string[] }
  | { ok: false; error: string; status: number };

export async function runIntentWatch(svc: Svc, watch: IntentWatch, now = new Date()): Promise<RunResult> {
  const cadence = isCadence(watch.cadence) ? watch.cadence : "daily";
  // Schedule the next run first so a crash cannot make the cron retry in a loop.
  await svc
    .from("intent_watches")
    .update({ next_run_at: nextRunAt(cadence, now).toISOString(), last_run_at: now.toISOString() })
    .eq("id", watch.id);

  if (!watch.keywords.length && !watch.competitors.length) {
    await svc.from("intent_watches").update({ last_error: "Add at least one keyword or competitor." }).eq("id", watch.id);
    return { ok: false, error: "Add at least one keyword or competitor.", status: 400 };
  }

  // Check the balance up front, but charge only after a search actually ran:
  // a sweep that could not reach any source must not cost anything.
  const { data: prof } = await svc.from("profiles").select(CREDIT_COLUMNS).eq("id", watch.owner_id).maybeSingle();
  if (spendableCredits(prof as TrialProfile | null) < INTENT_SWEEP_CREDITS) {
    const msg = `Out of credits: a sweep costs ${INTENT_SWEEP_CREDITS}. Buy credits to resume this watch.`;
    await svc.from("intent_watches").update({ last_error: msg }).eq("id", watch.id);
    return { ok: false, error: msg, status: 402 };
  }

  const recency = cadence === "daily" ? "week" : "day";
  const notes: string[] = [];
  let calls = 0;
  const hits: IntentHit[] = [];
  try {
    const native = await sweepNative({
      terms: [...watch.keywords.slice(0, 4), ...watch.competitors.slice(0, 2)],
      keywords: [...watch.keywords, ...watch.competitors],
      negativeKeywords: watch.negative_keywords,
      sources: watch.sources,
      days: cadence === "daily" ? 7 : 2,
      minIntent: watch.min_score,
      now,
    });
    calls += native.calls;
    hits.push(...native.hits);
    notes.push(...native.notes);
    if (watch.keywords.length) {
      const r = await sweepIntent({
        topic: watch.keywords.slice(0, 3).join(" OR "),
        keywords: watch.keywords,
        negativeKeywords: watch.negative_keywords,
        sources: watch.sources.length ? watch.sources : undefined,
        maxCalls: KEYWORD_CALL_BUDGET,
        recency,
        minIntent: watch.min_score,
        sells: watch.sells,
        now,
      });
      calls += r.calls;
      hits.push(...r.hits);
      notes.push(...r.notes);
    }
    if (watch.competitors.length) {
      // Competitor names are the topic: the phrasings already include
      // "alternatives to", "what do you use" and "we are evaluating".
      const r = await sweepIntent({
        topic: watch.competitors.slice(0, 3).map((c) => `"${c}"`).join(" OR "),
        keywords: watch.competitors,
        negativeKeywords: watch.negative_keywords,
        sources: watch.sources.length ? watch.sources : undefined,
        maxCalls: COMPETITOR_CALL_BUDGET,
        recency,
        minIntent: watch.min_score,
        now,
      });
      calls += r.calls;
      hits.push(...r.hits);
      notes.push(...r.notes.map((n) => `competitors: ${n}`));
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Search failed outright: nothing was charged yet.
    await svc.from("intent_watches").update({ last_error: msg.slice(0, 500) }).eq("id", watch.id);
    return { ok: false, error: msg, status: 502 };
  }

  if (calls === 0) {
    const msg = "No source could be searched this run (search providers unavailable). Nothing was charged.";
    await svc.from("intent_watches").update({ last_error: msg }).eq("id", watch.id);
    return { ok: false, error: msg, status: 503 };
  }
  const { data: paid, error: payErr } = await svc.rpc("consume_credit", {
    p_owner: watch.owner_id,
    p_count: INTENT_SWEEP_CREDITS,
  });
  if (payErr || !paid) {
    const msg = `Out of credits: a sweep costs ${INTENT_SWEEP_CREDITS}. Buy credits to resume this watch.`;
    await svc.from("intent_watches").update({ last_error: msg }).eq("id", watch.id);
    return { ok: false, error: msg, status: 402 };
  }

  const byUrl = new Map<string, IntentHit>();
  for (const h of hits) {
    const prev = byUrl.get(h.url);
    if (!prev || prev.signal.score < h.signal.score) byUrl.set(h.url, h);
  }
  const rows = [...byUrl.values()].map((h) => ({
    watch_id: watch.id,
    owner_id: watch.owner_id,
    source: h.source,
    url: h.url,
    title: h.title.slice(0, 500),
    snippet: h.snippet.slice(0, 2000),
    posted_at: h.postedAt?.toISOString() ?? null,
    score: Math.round(h.signal.score),
    tier: leadTier(h.signal.score),
    intent_kind: h.signal.tier === "none" ? null : h.signal.tier,
    competitor: matchCompetitor(`${h.title}\n${h.snippet}`, watch.competitors),
    reasons: h.signal.reasons.slice(0, 8),
    decision_maker: h.signal.decisionMaker,
  }));

  let inserted: LeadRow[] = [];
  if (rows.length) {
    const { data, error } = await svc
      .from("intent_leads")
      .upsert(rows, { onConflict: "watch_id,url", ignoreDuplicates: true })
      .select("id, source, url, title, snippet, posted_at, score, tier, intent_kind, competitor, status, created_at");
    if (error) {
      await svc.from("intent_watches").update({ last_error: error.message }).eq("id", watch.id);
      return { ok: false, error: error.message, status: 500 };
    }
    inserted = ((data ?? []) as LeadRow[]).sort((a, b) => b.score - a.score);
  }

  let deliveries: DeliveryResult[] = [];
  if (inserted.length) {
    const { data: prof } = await svc.from("profiles").select("email").eq("id", watch.owner_id).maybeSingle();
    deliveries = await deliverLeads(watch, inserted, (prof?.email as string | undefined) ?? null);
    await svc
      .from("intent_leads")
      .update({ delivered_at: new Date().toISOString() })
      .in(
        "id",
        inserted.map((l) => l.id!),
      );
  }
  const failed = deliveries.filter((d) => !d.ok);
  await svc
    .from("intent_watches")
    .update({ last_error: failed.length ? failed.map((d) => `${d.channel}: ${d.error}`).join("; ").slice(0, 500) : null })
    .eq("id", watch.id);

  return { ok: true, found: rows.length, inserted: inserted.length, calls, deliveries, notes };
}
