// Alert polling + dedupe engine. One entry point, checkAlert(), runs a single
// alert: poll ValueSERP → dedupe by canonical URL → (for backlinks) crawl-
// confirm → persist never-seen findings as pending (emailed_at NULL). A
// separate worker step batches pending findings into one digest per user.

import type { serviceClient } from "@/lib/supabase/service";
import type { Recency } from "./categories";
import { searchSerp, type SerpResult } from "./valueserp";
import { canonicalizeUrl } from "./dedupe";
import { confirmBacklink } from "./backlink";
import { RESULTS_PER_CHECK, MAX_BACKLINK_CRAWLS_PER_CHECK } from "./limits";

type Svc = ReturnType<typeof serviceClient>;

export type AlertRow = {
  id: string;
  owner_id: string;
  email: string;
  category: string;
  label: string;
  input_term: string;
  compiled_query: string;
  recency: Recency;
  frequency: "daily" | "hourly";
  status: string;
  confirm_backlink: boolean;
  backlink_domain: string | null;
  seeded: boolean;
};

export type CheckResult = {
  ok: boolean;
  alertId: string;
  seeded: boolean; // true when this was the silent cold-start poll
  newFindings: number;
  calls: number;
  error?: string;
};

function nextRunAt(frequency: "daily" | "hourly"): string {
  const ms = frequency === "hourly" ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
  return new Date(Date.now() + ms).toISOString();
}

type Candidate = SerpResult & { canonical: string };

function toCandidates(results: SerpResult[]): Candidate[] {
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const r of results) {
    const canonical = canonicalizeUrl(r.url);
    if (!canonical || seen.has(canonical)) continue; // in-batch dedupe
    seen.add(canonical);
    out.push({ ...r, canonical });
  }
  return out;
}

/**
 * Poll and process one alert. Reserving SERP budget is the caller's job; this
 * returns the calls consumed so the caller can reconcile.
 */
export async function checkAlert(svc: Svc, alert: AlertRow): Promise<CheckResult> {
  const serp = await searchSerp({
    query: alert.compiled_query,
    recency: alert.recency,
    num: RESULTS_PER_CHECK,
  });

  const finish = async () => {
    await svc
      .from("alerts")
      .update({ last_checked_at: new Date().toISOString(), next_run_at: nextRunAt(alert.frequency) })
      .eq("id", alert.id);
  };

  if (!serp.ok) {
    await finish();
    return { ok: false, alertId: alert.id, seeded: false, newFindings: 0, calls: serp.calls, error: serp.error };
  }

  const candidates = toCandidates(serp.results);

  // Which canonicals have we already shown for this alert?
  const canonicals = candidates.map((c) => c.canonical);
  const seenSet = new Set<string>();
  if (canonicals.length) {
    const { data: seenRows } = await svc
      .from("alert_seen_urls")
      .select("canonical_url")
      .eq("alert_id", alert.id)
      .in("canonical_url", canonicals);
    for (const row of (seenRows ?? []) as { canonical_url: string }[]) seenSet.add(row.canonical_url);
  }
  const fresh = candidates.filter((c) => !seenSet.has(c.canonical));

  // Cold start: the first poll only seeds the dedupe set — no email, no crawl.
  // Value on creation comes from the instant test-run preview, not a blast of
  // pre-existing SERP results.
  if (!alert.seeded) {
    if (fresh.length) {
      await svc.from("alert_seen_urls").upsert(
        fresh.map((c) => ({ alert_id: alert.id, canonical_url: c.canonical })),
        { onConflict: "alert_id,canonical_url", ignoreDuplicates: true },
      );
    }
    await svc.from("alerts").update({
      seeded: true,
      last_checked_at: new Date().toISOString(),
      next_run_at: nextRunAt(alert.frequency),
    }).eq("id", alert.id);
    return { ok: true, alertId: alert.id, seeded: true, newFindings: 0, calls: serp.calls };
  }

  // Decide which fresh candidates become findings.
  const seenToInsert: string[] = [];
  const findings: Array<{
    alert_id: string;
    owner_id: string;
    url: string;
    canonical_url: string;
    title: string;
    snippet: string;
    position: number;
    category: string;
    confirmed_backlink: boolean;
  }> = [];

  let crawls = 0;
  for (const c of fresh) {
    if (alert.confirm_backlink && alert.backlink_domain) {
      if (crawls >= MAX_BACKLINK_CRAWLS_PER_CHECK) break;
      crawls++;
      let check = await confirmBacklink(c.url, alert.backlink_domain);
      if (check.fetchError) {
        // Retry once before dropping; never report a fetch failure as a link.
        check = await confirmBacklink(c.url, alert.backlink_domain);
      }
      if (check.fetchError) {
        // Dropped this cycle; leave it unseen so a later poll can retry.
        continue;
      }
      // Fetched cleanly — record as seen either way so we don't re-crawl it.
      seenToInsert.push(c.canonical);
      if (!check.confirmed) continue;
      findings.push({
        alert_id: alert.id,
        owner_id: alert.owner_id,
        url: c.url,
        canonical_url: c.canonical,
        title: c.title,
        snippet: c.snippet,
        position: c.position,
        category: alert.category,
        confirmed_backlink: true,
      });
    } else {
      seenToInsert.push(c.canonical);
      findings.push({
        alert_id: alert.id,
        owner_id: alert.owner_id,
        url: c.url,
        canonical_url: c.canonical,
        title: c.title,
        snippet: c.snippet,
        position: c.position,
        category: alert.category,
        confirmed_backlink: false,
      });
    }
  }

  if (seenToInsert.length) {
    await svc.from("alert_seen_urls").upsert(
      seenToInsert.map((canonical_url) => ({ alert_id: alert.id, canonical_url })),
      { onConflict: "alert_id,canonical_url", ignoreDuplicates: true },
    );
  }
  if (findings.length) {
    await svc.from("alert_findings").insert(findings);
  }
  await finish();

  return { ok: true, alertId: alert.id, seeded: false, newFindings: findings.length, calls: serp.calls };
}

/** Instant test-run preview: fetch current results without persisting. */
export async function previewAlert(input: {
  query: string;
  recency: Recency;
}): Promise<{ ok: boolean; results: SerpResult[]; calls: number; error?: string }> {
  const serp = await searchSerp({ query: input.query, recency: input.recency, num: RESULTS_PER_CHECK });
  return { ok: serp.ok, results: serp.results, calls: serp.calls, error: serp.error };
}
