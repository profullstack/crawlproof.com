// The shape of a campaign request, parsed without touching a database.
//
// Kept apart from lib/ads/campaigns.ts because that module reaches the
// generator and the org helper, which are server-only; this one is imported
// by tests and could be by a client.

import { isAllowedTargetUrl } from "@/lib/rateLimit";

export type CampaignStatus = "active" | "draft";

export type CampaignRequest = {
  url: string;
  name?: string;
  dailyBudgetCents?: number;
  bidCredits?: number;
  status?: CampaignStatus;
};

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
  return { ok: true, request, url: check.url };
}
