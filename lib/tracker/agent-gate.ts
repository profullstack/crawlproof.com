import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Ban, throttle and back off an agent by its User-Agent.
 *
 * One honest caveat before anything else, because it decides whether this
 * feature does what a reader expects. This gate sits on the ANALYTICS beacon.
 * By the time a request reaches it, the crawler has already been served the page
 * by the customer's own origin. Refusing here stops the request being recorded
 * and tells the operator how to resolve it; it does not stop the crawl. Actually
 * blocking a crawler has to happen where the page is served. What this buys is a
 * clean dashboard, a name for the offender, and a channel to bill them.
 */

/** A rolling hour. Long enough to be meaningful, short enough to recover from. */
const WINDOW_MS = 60 * 60 * 1000;

/** Requests per hour before an agent with no explicit rule is throttled. */
export const DEFAULT_HOURLY_LIMIT = 600;

/** First backoff, doubled per consecutive offending window. */
const BACKOFF_BASE_MS = 5 * 60 * 1000;

/** Ceiling. Past a day it is indistinguishable from a ban and reads as broken. */
const BACKOFF_MAX_MS = 24 * 60 * 60 * 1000;

/** A User-Agent longer than this is padding; the prefix identifies it. */
const UA_MAX = 512;

export type AgentDecision =
  | { action: "allow"; agentKey: string; userAgent: string | null }
  | {
      action: "ban" | "throttle";
      agentKey: string;
      userAgent: string | null;
      retryAfterSeconds: number;
      /** True the first time this agent is told, so the terms are sent once. */
      notify: boolean;
      reason: string;
    };

export function truncateAgent(ua: string | null): string | null {
  if (!ua) return null;
  const t = ua.trim();
  return t ? t.slice(0, UA_MAX) : null;
}

/**
 * Collapse a User-Agent to something stable enough to count against.
 *
 * Version numbers and build hashes are stripped, because a crawler that appends
 * one to every request would otherwise get a fresh counter on each hit and no
 * rate limit could ever bite. Everything is lowercased for the same reason.
 */
export function agentKeyOf(ua: string | null): string {
  if (!ua) return "(none)";
  return (
    ua
      .toLowerCase()
      // Version-like runs: 1.2, 1.2.3, 120.0.0.0
      .replace(/\d+(\.\d+)+/g, "#")
      // Bare long digit runs (build ids, timestamps)
      .replace(/\b\d{3,}\b/g, "#")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 200) || "(none)"
  );
}

/** Does a rule's pattern describe this agent? */
export function ruleMatches(
  ua: string,
  pattern: string,
  matchType: string,
): boolean {
  const haystack = ua.toLowerCase();
  const needle = pattern.toLowerCase().trim();
  if (!needle) return false;
  if (matchType === "exact") return haystack === needle;
  if (matchType === "regex") {
    try {
      // Applied here rather than in SQL so a bad pattern costs one request, not
      // a table scan, and cannot take the ingest down for everybody.
      return new RegExp(pattern, "i").test(ua);
    } catch {
      return false;
    }
  }
  return haystack.includes(needle);
}

/** Exponential, capped. strikes 0 -> 5m, 1 -> 10m, 2 -> 20m, ... */
export function backoffMs(strikes: number): number {
  const n = Math.max(0, Math.min(strikes, 20));
  return Math.min(BACKOFF_BASE_MS * 2 ** n, BACKOFF_MAX_MS);
}

type RuleRow = {
  pattern: string;
  match_type: string;
  action: string;
  hourly_limit: number | null;
};

/**
 * Decide what to do with this request.
 *
 * Best-effort throughout: any failure returns "allow". An analytics beacon that
 * starts refusing traffic because a counter table is briefly unavailable is a
 * worse outage than one that briefly over-counts.
 */
export async function gateAgent(
  sb: SupabaseClient,
  projectId: string,
  rawUserAgent: string | null,
): Promise<AgentDecision> {
  const userAgent = truncateAgent(rawUserAgent);
  const agentKey = agentKeyOf(userAgent);
  const allow: AgentDecision = { action: "allow", agentKey, userAgent };
  if (!userAgent) return allow;

  try {
    const { data: rules } = await sb
      .from("tracker_agent_rules")
      .select("pattern, match_type, action, hourly_limit")
      .eq("project_id", projectId);

    const matched = (rules ?? []).find((r: RuleRow) =>
      ruleMatches(userAgent, r.pattern, r.match_type),
    ) as RuleRow | undefined;

    const now = Date.now();

    const { data: state } = await sb
      .from("tracker_agent_state")
      .select(
        "window_started, window_count, strikes, blocked_until, first_throttled_at, notified_at, total_requests",
      )
      .eq("project_id", projectId)
      .eq("agent_key", agentKey)
      .maybeSingle();

    // A ban needs no counting. It is refused every time, and the terms are
    // repeated only once per backoff period so a banned crawler hammering the
    // endpoint does not get a paragraph back on every request.
    if (matched?.action === "ban") {
      const notify = shouldNotify(state?.notified_at, now);
      await writeState(sb, projectId, agentKey, userAgent, {
        window_started: new Date(state?.window_started ?? now).toISOString(),
        window_count: (state?.window_count ?? 0) + 1,
        strikes: state?.strikes ?? 0,
        blocked_until: new Date(now + BACKOFF_MAX_MS).toISOString(),
        first_throttled_at: state?.first_throttled_at ?? new Date(now).toISOString(),
        notified_at: notify ? new Date(now).toISOString() : (state?.notified_at ?? null),
        total_requests: Number(state?.total_requests ?? 0) + 1,
      });
      return {
        action: "ban",
        agentKey,
        userAgent,
        retryAfterSeconds: Math.round(BACKOFF_MAX_MS / 1000),
        notify,
        reason: "This user agent is not permitted on this property.",
      };
    }

    // Still inside a previous backoff.
    const blockedUntil = state?.blocked_until ? Date.parse(state.blocked_until) : 0;
    if (blockedUntil > now) {
      const notify = shouldNotify(state?.notified_at, now);
      if (notify) {
        await writeState(sb, projectId, agentKey, userAgent, {
          notified_at: new Date(now).toISOString(),
          total_requests: Number(state?.total_requests ?? 0) + 1,
          last_seen_at: new Date(now).toISOString(),
        });
      }
      return {
        action: "throttle",
        agentKey,
        userAgent,
        retryAfterSeconds: Math.max(1, Math.round((blockedUntil - now) / 1000)),
        notify,
        reason: "Rate limit exceeded.",
      };
    }

    // Roll the window if it has expired.
    const windowStarted = state?.window_started ? Date.parse(state.window_started) : now;
    const windowLive = now - windowStarted < WINDOW_MS;
    const count = (windowLive ? (state?.window_count ?? 0) : 0) + 1;
    const limit = matched?.hourly_limit ?? DEFAULT_HOURLY_LIMIT;

    if (count > limit) {
      // A fresh window that also blew the limit is a consecutive offence, so the
      // exponent grows. An agent that behaves for a whole window resets below.
      const strikes = (state?.strikes ?? 0) + 1;
      const until = now + backoffMs(strikes - 1);
      const first = !state?.first_throttled_at;
      const notify = first || shouldNotify(state?.notified_at, now);

      await writeState(sb, projectId, agentKey, userAgent, {
        window_started: new Date(now).toISOString(),
        window_count: 0,
        strikes,
        blocked_until: new Date(until).toISOString(),
        first_throttled_at: state?.first_throttled_at ?? new Date(now).toISOString(),
        notified_at: notify ? new Date(now).toISOString() : (state?.notified_at ?? null),
        total_requests: Number(state?.total_requests ?? 0) + 1,
      });

      return {
        action: "throttle",
        agentKey,
        userAgent,
        retryAfterSeconds: Math.max(1, Math.round((until - now) / 1000)),
        notify,
        reason: `Rate limit exceeded: more than ${limit} requests in an hour.`,
      };
    }

    // Under the limit. A clean window clears the strike count, so an agent that
    // corrects itself is not punished forever for one bad afternoon.
    await writeState(sb, projectId, agentKey, userAgent, {
      window_started: new Date(windowLive ? windowStarted : now).toISOString(),
      window_count: count,
      strikes: windowLive ? (state?.strikes ?? 0) : 0,
      blocked_until: null,
      total_requests: Number(state?.total_requests ?? 0) + 1,
    });

    return allow;
  } catch {
    // See the note on the function: never let this refuse real traffic.
    return allow;
  }
}

/** Once per backoff period, not once per request. */
function shouldNotify(notifiedAt: string | null | undefined, now: number): boolean {
  if (!notifiedAt) return true;
  return now - Date.parse(notifiedAt) > BACKOFF_BASE_MS;
}

async function writeState(
  sb: SupabaseClient,
  projectId: string,
  agentKey: string,
  userAgent: string | null,
  patch: Record<string, unknown>,
): Promise<void> {
  await sb.from("tracker_agent_state").upsert(
    {
      project_id: projectId,
      agent_key: agentKey,
      user_agent: userAgent,
      last_seen_at: new Date().toISOString(),
      ...patch,
    },
    { onConflict: "project_id,agent_key" },
  );
}
