// Free-tier caps and cost backstops for CrawlProof Alerts.
//
// The PRD's "50 queries" cap is a proxy; the *real* cost control is a monthly
// per-account SERP-call budget. A single free user maxing 50 daily alerts is
// 50 × 30 = 1,500 ValueSERP calls/month ≈ $1.50–$3.00 — 10–20× the stated
// $0.15/free-user ceiling. The blended average stays low only because most
// users run a handful of alerts; the call budget bounds the tail so one power
// user (or an abuse account) can't blow the unit economics.

export type Plan = "free" | "pro" | "team";

// Max simultaneously-active alerts by plan (paused alerts don't count).
export const MAX_ACTIVE_ALERTS: Record<Plan, number> = {
  free: 50,
  pro: 250,
  team: 1000,
};

// Monthly SERP-call budget by plan — the hard cost backstop. Free is set so a
// typical user never touches it, while a cap-abuser is bounded to well under
// a dollar. Paid budgets assume hourly checks (24× the call volume).
export const SERP_CALLS_PER_MONTH: Record<Plan, number> = {
  free: 400,
  pro: 200_000,
  team: 1_000_000,
};

// Hourly is currently free for everyone (no paywall on frequency yet — the
// per-account monthly SERP-call budget is what bounds cost). Revisit if/when
// hourly becomes a paid lever.
export function allowedFrequencies(_plan: Plan): Array<"daily" | "hourly"> {
  return ["daily", "hourly"];
}

// Results requested per poll and surfaced per email. Capping at 10 keeps SERP
// cost to one call and controls email noise (top results by SERP position).
export const RESULTS_PER_CHECK = 10;

// Backlink discovery crawls candidates; cap how many we crawl per check so a
// broad query can't fan out into dozens of fetches.
export const MAX_BACKLINK_CRAWLS_PER_CHECK = 12;

export function planFromProfile(plan: string | null | undefined): Plan {
  return plan === "pro" || plan === "team" ? plan : "free";
}
