// The shape of a campaign request, parsed without touching a database.
//
// Kept apart from lib/ads/campaigns.ts because that module reaches the
// generator and the org helper, which are server-only; this one is imported
// by tests and could be by a client.

import { isAllowedTargetUrl } from "@/lib/rateLimit";
import { cleanTopics } from "@/lib/ads/trending";

export type CampaignStatus = "active" | "draft";

export type CampaignRequest = {
  url: string;
  name?: string;
  dailyBudgetCents?: number;
  bidCredits?: number;
  status?: CampaignStatus;
  /** Prefer this campaign where its subject is what people are asking about. */
  trendingTopics?: boolean;
  /** The subjects it is about. Derived from the page when the caller says nothing. */
  topics?: string[];
};

/**
 * A boolean as somebody typed it.
 *
 * `--trending` from a shell arrives as the string "true", a JSON caller sends
 * a real boolean, and a form sends "on". Anything else is not a yes.
 */
function asBoolean(value: unknown): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "boolean") return value;
  const text = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(text)) return true;
  if (["false", "0", "no", "off", ""].includes(text)) return false;
  return undefined;
}

export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/**
 * Normalise what a caller sent. Pure, so it is testable without a database:
 * the clamps here are the same ones saveCampaign applies.
 */
export function parseCampaignRequest(body: Record<string, unknown>): { ok: true; request: CampaignRequest; url: string } | { ok: false; error: string } {
  const rawUrl = typeof body.url === "string" ? body.url : "";
  const check = isAllowedTargetUrl(rawUrl);
  if (!check.ok) return { ok: false, error: check.reason };

  const budgetRaw = body.daily_budget_cents ?? body.dailyBudgetCents;
  const bidRaw = body.bid_credits ?? body.bidCredits;
  const statusRaw = body.status;
  if (statusRaw !== undefined && statusRaw !== "active" && statusRaw !== "draft") {
    return { ok: false, error: 'status must be "active" or "draft".' };
  }

  const request: CampaignRequest = { url: check.url };
  if (typeof body.name === "string" && body.name.trim()) request.name = body.name.trim().slice(0, 120);
  if (budgetRaw !== undefined && budgetRaw !== null) {
    const n = Number(budgetRaw);
    if (!Number.isFinite(n) || n < 0) return { ok: false, error: "daily_budget_cents must be a non-negative number." };
    request.dailyBudgetCents = Math.round(n);
  }
  if (bidRaw !== undefined && bidRaw !== null) {
    const n = Number(bidRaw);
    if (!Number.isFinite(n) || n < 1) return { ok: false, error: "bid_credits must be at least 1." };
    request.bidCredits = Math.min(200, Math.round(n));
  }
  if (statusRaw === "active" || statusRaw === "draft") request.status = statusRaw;

  const trending = asBoolean(body.trending_topics ?? body.trendingTopics ?? body.trending);
  if (trending !== undefined) request.trendingTopics = trending;
  const topics = cleanTopics(body.topics);
  if (topics.length) request.topics = topics;
  return { ok: true, request, url: check.url };
}

export type CampaignPatch = {
  name?: string;
  dailyBudgetCents?: number;
  bidCredits?: number;
  status?: "active" | "paused" | "draft";
  trendingTopics?: boolean;
  topics?: string[];
};

/** Pure: a PATCH body, normalised with the dashboard's clamps. Empty is an error. */
export function parseCampaignPatch(body: Record<string, unknown>): { ok: true; patch: CampaignPatch } | { ok: false; error: string } {
  const patch: CampaignPatch = {};
  if (body.name !== undefined) {
    if (typeof body.name !== "string" || !body.name.trim()) return { ok: false, error: "name must be a non-empty string." };
    patch.name = body.name.trim().slice(0, 120);
  }
  const budgetRaw = body.daily_budget_cents ?? body.dailyBudgetCents;
  if (budgetRaw !== undefined) {
    const n = Number(budgetRaw);
    if (!Number.isFinite(n) || n < 0) return { ok: false, error: "daily_budget_cents must be a non-negative number." };
    patch.dailyBudgetCents = Math.round(n);
  }
  const bidRaw = body.bid_credits ?? body.bidCredits;
  if (bidRaw !== undefined) {
    const n = Number(bidRaw);
    if (!Number.isFinite(n) || n < 1) return { ok: false, error: "bid_credits must be at least 1." };
    patch.bidCredits = Math.min(200, Math.round(n));
  }
  if (body.status !== undefined) {
    if (body.status !== "active" && body.status !== "paused" && body.status !== "draft") {
      return { ok: false, error: 'status must be "active", "paused" or "draft".' };
    }
    patch.status = body.status;
  }
  const trending = asBoolean(body.trending_topics ?? body.trendingTopics ?? body.trending);
  if (trending !== undefined) patch.trendingTopics = trending;
  if (body.topics !== undefined) patch.topics = cleanTopics(body.topics);
  if (!Object.keys(patch).length) {
    return { ok: false, error: "Nothing to change: send name, daily_budget_cents, bid_credits, status, trending_topics or topics." };
  }
  return { ok: true, patch };
}

/** A campaign is named by its id or by its ref slug (crawlproof-ad-144). */
export const isRefSlug = (value: string): boolean => /^crawlproof-ad-\d+$/i.test(value.trim());
