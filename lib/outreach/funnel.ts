// Measured outreach funnel, at three levels: the whole project, one campaign,
// and one tick.
//
// Everything here is counted from what actually happened — live sends in
// outreach_sends, prospect statuses that a human or a reply-check moved — not
// from benchmark rates. Published conversion numbers are worth very little
// when they are somebody else's: the point of showing these is that they are
// this account's own, on this campaign, and get truer the longer it runs.
//
// Rates are deliberately absent until there is enough volume to mean
// anything. One reply out of three sends is not a 33% reply rate, and
// rendering it as one invites a decision that the sample cannot support.

import { serviceClient } from "@/lib/supabase/service";

/** Below this many sends, a percentage is noise rather than a rate. */
const MIN_SENDS_FOR_RATE = 20;

export type FunnelCounts = {
  /** Live sends. Dry runs are excluded — nobody received them. */
  sent: number;
  /** Distinct people contacted, which is what a rate should divide by. */
  contacted: number;
  replied: number;
  won: number;
  lost: number;
  /** Null until the sample is large enough to carry a percentage. */
  replyRate: number | null;
  closeRate: number | null;
  /** Why a rate is missing, for the UI to show instead of a number. */
  rateNote: string | null;
};

export type CampaignFunnel = FunnelCounts & { campaign: string };

function rates(counts: Omit<FunnelCounts, "replyRate" | "closeRate" | "rateNote">): FunnelCounts {
  if (counts.sent < MIN_SENDS_FOR_RATE) {
    return {
      ...counts,
      replyRate: null,
      closeRate: null,
      rateNote: `needs ${MIN_SENDS_FOR_RATE - counts.sent} more sends before a rate means anything`,
    };
  }
  const replyRate = counts.contacted > 0 ? counts.replied / counts.contacted : 0;
  // Close rate is of people who replied, not of everyone contacted — a deal
  // comes out of a conversation, and dividing by silence flatters nothing.
  const closeRate = counts.replied > 0 ? counts.won / counts.replied : null;
  return {
    ...counts,
    replyRate,
    closeRate,
    rateNote: counts.replied === 0 ? "no replies yet, so there is no close rate to show" : null,
  };
}

/**
 * The whole project: every campaign plus anything sent by hand.
 */
export async function projectFunnel(projectId: string): Promise<FunnelCounts> {
  const sb = serviceClient();
  const [{ count: sent }, { data: prospects }] = await Promise.all([
    sb
      .from("outreach_sends")
      .select("id", { count: "exact", head: true })
      .eq("project_id", projectId)
      .eq("channel", "email")
      .eq("dry_run", false),
    sb
      .from("outreach_prospects")
      .select("status")
      .eq("project_id", projectId)
      .eq("channel", "email")
      .in("status", ["contacted", "replied", "won", "lost"]),
  ]);

  return rates(tally(sent ?? 0, (prospects as { status: string }[] | null) ?? []));
}

/** Per campaign, ordered by volume so the busiest reads first. */
export async function campaignFunnels(projectId: string): Promise<CampaignFunnel[]> {
  const sb = serviceClient();
  const [{ data: sends }, { data: prospects }] = await Promise.all([
    sb
      .from("outreach_sends")
      .select("campaign")
      .eq("project_id", projectId)
      .eq("channel", "email")
      .eq("dry_run", false),
    sb
      .from("outreach_prospects")
      .select("status, campaign_id")
      .eq("project_id", projectId)
      .eq("channel", "email")
      .in("status", ["contacted", "replied", "won", "lost"]),
  ]);

  // Sends record the campaign by name; prospects by id. Names are what the
  // user sees, so they are the join key here and the id is mapped onto it.
  const { data: campaigns } = await sb
    .from("outreach_campaigns")
    .select("id, name")
    .eq("project_id", projectId);
  const nameById = new Map(
    ((campaigns as { id: string; name: string }[] | null) ?? []).map((c) => [c.id, c.name]),
  );

  const sentByCampaign = new Map<string, number>();
  for (const s of ((sends as { campaign: string | null }[] | null) ?? [])) {
    const key = s.campaign ?? "(manual)";
    sentByCampaign.set(key, (sentByCampaign.get(key) ?? 0) + 1);
  }

  const statusesByCampaign = new Map<string, { status: string }[]>();
  for (const p of ((prospects as { status: string; campaign_id: string | null }[] | null) ?? [])) {
    const key = (p.campaign_id && nameById.get(p.campaign_id)) || "(manual)";
    const list = statusesByCampaign.get(key) ?? [];
    list.push({ status: p.status });
    statusesByCampaign.set(key, list);
  }

  const names = new Set([...sentByCampaign.keys(), ...statusesByCampaign.keys()]);
  return [...names]
    .map((campaign) => ({
      campaign,
      ...rates(tally(sentByCampaign.get(campaign) ?? 0, statusesByCampaign.get(campaign) ?? [])),
    }))
    .sort((a, b) => b.sent - a.sent);
}

function tally(
  sent: number,
  prospects: { status: string }[],
): Omit<FunnelCounts, "replyRate" | "closeRate" | "rateNote"> {
  let replied = 0;
  let won = 0;
  let lost = 0;
  for (const p of prospects) {
    if (p.status === "replied") replied += 1;
    // A won or lost prospect replied first — it cannot become either without
    // a conversation — so it counts toward replies as well as its own bucket.
    else if (p.status === "won") {
      won += 1;
      replied += 1;
    } else if (p.status === "lost") {
      lost += 1;
      replied += 1;
    }
  }
  return { sent, contacted: prospects.length, replied, won, lost };
}
