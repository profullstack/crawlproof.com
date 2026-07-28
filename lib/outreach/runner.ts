// The autopilot: one tick of a campaign.
//
// This is what makes the feature lead *generation* rather than a nicer way to
// email people you already found. A tick walks the funnel back-to-front —
// follow-ups, then first sends, then research, then discovery — so work
// already invested in a prospect finishes before new leads pile in behind it.
//
// Everything is bounded per tick and resumable. The cron route calls this;
// so does the MCP run_campaign tool, so "what the robot does" and "what the
// agent does" cannot drift apart.

import { serviceClient } from "@/lib/supabase/service";
import { env } from "@/lib/env";
import { discoverProspects } from "./discover";
import { isEmailSuppressed, sendsInLast24h } from "./suppress";
import {
  PROSPECT_COLUMNS,
  draftEmail,
  isWeakEnough,
  latestAuditForHost,
  researchProspect,
  sendProspectEmail,
  type CampaignPitch,
  type ProspectRow,
} from "./pipeline";
import { nextStepReadyAt, type OutreachStep } from "./cold";
import { leadRunBilling, outOfCreditsNote } from "./billing";
import { recordDiscoveredPeople } from "./contacts";
import { LEAD_RUN_CREDITS } from "@/lib/credits";

export type CampaignRow = {
  id: string;
  project_id: string;
  owner_id: string;
  name: string;
  channel: string;
  active: boolean;
  queries: string[];
  seed_urls: string[];
  keywords: string[];
  subreddits: string[];
  negative_keywords: string[];
  max_score: number;
  daily_send_limit: number;
  target_pipeline: number;
  auto_send: boolean;
  follow_ups: boolean;
  angle: string | null;
  pitch_mode: "audit" | "custom";
  pitch_intro: string | null;
  pitch_ask: string | null;
  pitch_facts: string[] | null;
  scan_prospects: boolean;
  sender_name: string | null;
  reply_to: string | null;
  last_run_at: string | null;
};

export const CAMPAIGN_COLUMNS =
  "id, project_id, owner_id, name, channel, active, queries, seed_urls, keywords, subreddits, negative_keywords, max_score, daily_send_limit, target_pipeline, auto_send, follow_ups, angle, sender_name, reply_to, last_run_at, pitch_mode, pitch_intro, pitch_ask, pitch_facts, scan_prospects";

export type TickResult = {
  campaign: string;
  discovered: number;
  scansStarted: number;
  researched: number;
  drafted: number;
  sent: number;
  dryRuns: number;
  /** The campaign's actual auto_send setting, so the summary can't misreport it. */
  autoSend: boolean;
  /** Seed URLs sitting behind a sign-in with no stored credential. */
  awaitingAuth: string[];
  /** Credits this tick actually charged. Zero when it found nothing to do. */
  creditsSpent: number;
  /** People named by this tick and written to the shared contact record. */
  peopleRecorded: number;
  skipped: string[];
  errors: string[];
};

// Per-tick ceilings. Small on purpose: a tick runs every 15 minutes, and the
// slow part (scanning, then waiting for a worker) is not made faster by
// queueing five hundred domains at once.
const MAX_DISCOVER_PER_TICK = 15;
const MAX_RESEARCH_PER_TICK = 8;
const MAX_SEND_PER_TICK = 5;
// Ceiling on search-based contact lookups per tick. The fallback is the most
// variable cost in a run — SERP calls scale with how many prospects publish
// no address — so it gets a ceiling like every other per-tick stage.
const MAX_CONTACT_SEARCHES_PER_TICK = 10;

export async function runEmailCampaignTick(campaign: CampaignRow): Promise<TickResult> {
  const sb = serviceClient();
  // Shared across every prospect this tick researches, so the ceiling is per
  // run rather than per prospect.
  const contactSearchBudget = { remaining: MAX_CONTACT_SEARCHES_PER_TICK };
  const result: TickResult = {
    campaign: campaign.name,
    discovered: 0,
    scansStarted: 0,
    autoSend: campaign.auto_send,
    awaitingAuth: [],
    creditsSpent: 0,
    peopleRecorded: 0,
    researched: 0,
    drafted: 0,
    sent: 0,
    dryRuns: 0,
    skipped: [],
    errors: [],
  };

  // Lazy: nothing is charged until a stage below actually reaches for search
  // or a model. A tick that finds nothing to do is free, which is what makes
  // leaving a campaign switched on affordable at one tick every fifteen
  // minutes.
  const billing = leadRunBilling(campaign.owner_id);
  /** Whether this tick may spend. Records the reason once if it may not. */
  const canSpend = async (): Promise<boolean> => {
    if (await billing.authorize()) return true;
    if (!result.errors.includes(outOfCreditsNote())) result.errors.push(outOfCreditsNote());
    return false;
  };

  const { data: pool } = await sb
    .from("outreach_prospects")
    .select(PROSPECT_COLUMNS)
    .eq("project_id", campaign.project_id)
    .eq("channel", "email")
    .eq("campaign_id", campaign.id)
    .limit(500);
  const prospects = (pool as ProspectRow[] | null) ?? [];

  // How much of today's budget is left. The campaign's own limit and the
  // global env cap both apply; the smaller wins.
  const usedToday = await sendsInLast24h({ ownerId: campaign.owner_id, channels: ["email"] });
  let sendBudget = Math.max(
    0,
    Math.min(campaign.daily_send_limit - countTodayForCampaign(prospects), env.outreachDailyCap - usedToday),
  );

  // ---- 1. Follow-ups. Finishing a started conversation beats starting one.
  if (campaign.follow_ups) {
    const due = prospects
      .filter((p) => p.status === "contacted" && p.last_sent_at && p.last_step >= 1 && p.last_step < 3)
      .filter((p) => {
        const step = (p.last_step + 1) as OutreachStep;
        return nextStepReadyAt(new Date(p.last_sent_at as string), step).getTime() <= Date.now();
      })
      .slice(0, MAX_SEND_PER_TICK);

    for (const p of due) {
      if (sendBudget <= 0) break;
      // Drafting a follow-up costs a model call like any other stage.
      if (!(await canSpend())) break;
      const step = (p.last_step + 1) as OutreachStep;
      const outcome = await draftAndSend(campaign, p, step);
      applyOutcome(result, outcome);
      if (outcome.kind === "sent") sendBudget -= 1;
    }
  }

  // ---- 2. First contact for researched prospects that are weak enough.
  const ready = prospects
    .filter((p) => p.status === "researched" && p.contact_email && p.last_step === 0)
    // The score gate exists so we never pitch a fix to a site that doesn't
    // need one. A campaign that isn't pitching a fix has nothing to gate on,
    // and applying it anyway would filter out every prospect, since an
    // unscanned one has no score.
    .filter(
      (p) =>
        !campaign.scan_prospects ||
        isWeakEnough({
          score: p.score,
          engine: p.score_kind === "slop" ? "slop" : "rule",
          maxScore: campaign.max_score,
        }),
    )
    .slice(0, MAX_SEND_PER_TICK);

  for (const p of ready) {
    if (sendBudget <= 0) {
      result.skipped.push(`${p.target_key}: daily send budget exhausted`);
      break;
    }
    if (!(await canSpend())) break;
    const outcome = await draftAndSend(campaign, p, 1);
    applyOutcome(result, outcome);
    if (outcome.kind === "sent") sendBudget -= 1;
  }

  // Prospects that scored too well are not a lie we're willing to tell.
  for (const p of prospects) {
    if (
      p.status === "researched" &&
      p.score !== null &&
      !isWeakEnough({
        score: p.score,
        engine: p.score_kind === "slop" ? "slop" : "rule",
        maxScore: campaign.max_score,
      })
    ) {
      await sb.from("outreach_prospects").update({ status: "skipped", notes: "scores too well to pitch a fix" }).eq("id", p.id);
      result.skipped.push(`${p.target_key}: scores ${p.score}/100 — too good to pitch`);
    }
  }

  // ---- 3. Research anything whose scan has landed.
  const pending = prospects.filter((p) => p.status === "new").slice(0, MAX_RESEARCH_PER_TICK);
  for (const p of pending) {
    const audit = await latestAuditForHost(campaign.owner_id, p.target_key);
    // With scanning off there will never be an audit, so waiting for one
    // would strand every prospect at "new" forever.
    if (!audit && campaign.scan_prospects) continue; // still queued in the worker; next tick.
    // Checked here rather than before the loop: a prospect whose scan has not
    // landed is skipped above without spending anything, and billing for a
    // tick that only ever hit that branch would charge for waiting.
    if (!(await canSpend())) break;
    const res = await researchProspect({
      userId: campaign.owner_id,
      projectId: campaign.project_id,
      url: p.site_url ?? `https://${p.target_key}`,
      campaignId: campaign.id,
      skipScan: !campaign.scan_prospects,
      contactSearchBudget,
    });
    if (res.status === "researched") {
      result.researched += 1;
      if (!res.contact) {
        await sb
          .from("outreach_prospects")
          .update({ status: "skipped", notes: "no contact address published on the site" })
          .eq("id", p.id);
        result.skipped.push(`${p.target_key}: no published contact address`);
      }
    } else if (res.status === "error") {
      result.errors.push(`${p.target_key}: ${res.message}`);
    }
  }

  // ---- 4. Top the funnel up.
  const liveCount = prospects.filter((p) => ["new", "researched", "drafted"].includes(p.status)).length;
  // Discovery is the most expensive stage — several search calls before a
  // single prospect exists — so it is gated like the rest.
  if (liveCount < campaign.target_pipeline && (await canSpend())) {
    const want = Math.min(campaign.target_pipeline - liveCount, MAX_DISCOVER_PER_TICK);
    const { data: projectRow } = await sb
      .from("projects")
      .select("organization_id")
      .eq("id", campaign.project_id)
      .maybeSingle();
    const organizationId = (projectRow?.organization_id as string | null) ?? null;

    const found = await discoverProspects({
      queries: campaign.queries ?? [],
      seedUrls: campaign.seed_urls ?? [],
      limit: want * 3, // over-fetch: most candidates are already known or filtered
      organizationId,
    });
    result.errors.push(...found.errors);
    result.awaitingAuth = found.loginRequiredSeeds;

    // The people the run named, not just the companies. Reading prospects off
    // this result and ignoring `people` is what threw away every name, title
    // and profile link a directory gave up — after paying to render, paginate
    // and parse for them.
    result.peopleRecorded = await recordDiscoveredPeople({
      organizationId,
      people: found.people,
      niche: campaign.name,
    });

    // Park the gated hosts on the campaign so the UI can say what it is
    // waiting for, and offer the form that unblocks it, instead of leaving
    // the reason buried in an error string.
    await sb
      .from("outreach_campaigns")
      .update({ auth_required_hosts: found.loginRequiredSeeds })
      .eq("id", campaign.id);

    const known = new Set(prospects.map((p) => p.target_key));
    let added = 0;
    for (const candidate of found.prospects) {
      if (added >= want) break;
      if (known.has(candidate.host)) continue;
      if (await isEmailSuppressed(`x@${candidate.host}`)) continue;

      // The same business being a lead for another project is fine — leads
      // are project-scoped — but a duplicate inside this project is not.
      const { data: existing } = await sb
        .from("outreach_prospects")
        .select("id")
        .eq("project_id", campaign.project_id)
        .eq("channel", "email")
        .eq("target_key", candidate.host)
        .maybeSingle();
      if (existing) continue;

      const res = await researchProspect({
        userId: campaign.owner_id,
        projectId: campaign.project_id,
        url: candidate.url,
        campaignId: campaign.id,
        discoveredVia: candidate.via,
        discoveryLabel: candidate.label,
        // The setting has to be honoured here too, not only when researching
        // prospects that are already on the board. This is the path that sees
        // every newly discovered domain, so missing it meant a campaign with
        // scanning off still scanned everything it found.
        skipScan: !campaign.scan_prospects,
        contactSearchBudget,
      });
      if (res.status === "scanning") {
        result.scansStarted += 1;
        result.discovered += 1;
        added += 1;
      } else if (res.status === "researched") {
        result.researched += 1;
        result.discovered += 1;
        added += 1;
      } else {
        result.errors.push(`${candidate.host}: ${res.message}`);
      }
    }
  }

  // A run that was charged and produced nothing gives the money back. Some of
  // it is genuinely spent by then — a search that returned no usable candidate
  // still cost a call — but billing for a tick with no output is a worse trade
  // than eating that occasionally.
  if (billing.charged() && !result.discovered && !result.researched && !result.drafted && !result.sent) {
    await billing.refund();
  }
  result.creditsSpent = billing.charged() ? LEAD_RUN_CREDITS : 0;

  const ranAt = new Date().toISOString();
  const summary = summarize(result);

  await sb
    .from("outreach_campaigns")
    .update({ last_run_at: ranAt, last_run_note: summary })
    .eq("id", campaign.id);

  // Keep the trail as well as the newest line. last_run_note is overwritten
  // every tick, so without this a run that errored vanishes fifteen minutes
  // later and "has this ever found anything?" has no answer.
  await sb.from("outreach_campaign_runs").insert({
    campaign_id: campaign.id,
    project_id: campaign.project_id,
    ran_at: ranAt,
    summary,
    discovered: result.discovered,
    scans_started: result.scansStarted,
    researched: result.researched,
    drafted: result.drafted,
    sent: result.sent,
    errors: result.errors,
    skipped: result.skipped,
    awaiting_auth: result.awaitingAuth,
    credits_spent: result.creditsSpent,
    ok: result.errors.length === 0,
  });

  return result;
}

type Outcome =
  | { kind: "sent"; host: string }
  | { kind: "dry"; host: string }
  | { kind: "skipped"; host: string; reason: string }
  | { kind: "error"; host: string; reason: string };


/**
 * The campaign's own pitch, or null when it is selling a CrawlProof scan.
 *
 * Null is what keeps every existing campaign on exactly the old path: the
 * audit pitch is the default and this feature is additive.
 */
function campaignPitch(campaign: CampaignRow): CampaignPitch | null {
  if (campaign.pitch_mode !== "custom") return null;
  const intro = (campaign.pitch_intro ?? "").trim();
  if (!intro) return null;
  return {
    intro,
    ask: campaign.pitch_ask,
    facts: Array.isArray(campaign.pitch_facts) ? campaign.pitch_facts : [],
  };
}

async function draftAndSend(
  campaign: CampaignRow,
  prospect: ProspectRow,
  step: OutreachStep,
): Promise<Outcome> {
  const draft = await draftEmail({
    prospect,
    step,
    angle: campaign.angle,
    sender: campaign.sender_name,
    pitch: campaignPitch(campaign),
  });
  if (!draft.ok) {
    return { kind: "error", host: prospect.target_key, reason: draft.problems.join("; ") };
  }

  // auto_send off means the campaign builds the whole funnel and stops at the
  // wire. The draft still goes through sendProspectEmail so it lands in the
  // send log as a dry run and can be read before anyone flips the switch.
  const outcome = await sendProspectEmail({
    userId: campaign.owner_id,
    prospect,
    subject: draft.subject,
    body: draft.body,
    step,
    campaign: campaign.name,
    replyTo: campaign.reply_to,
    dryRun: !campaign.auto_send,
  });

  if (!outcome.ok) return { kind: "skipped", host: prospect.target_key, reason: outcome.reason };
  return outcome.dryRun
    ? { kind: "dry", host: prospect.target_key }
    : { kind: "sent", host: prospect.target_key };
}

function applyOutcome(result: TickResult, outcome: Outcome): void {
  switch (outcome.kind) {
    case "sent":
      result.sent += 1;
      result.drafted += 1;
      break;
    case "dry":
      result.dryRuns += 1;
      result.drafted += 1;
      break;
    case "skipped":
      result.skipped.push(`${outcome.host}: ${outcome.reason}`);
      break;
    case "error":
      result.errors.push(`${outcome.host}: ${outcome.reason}`);
      break;
  }
}

/** Live sends this campaign has already made in the last 24h. */
function countTodayForCampaign(prospects: ProspectRow[]): number {
  const cutoff = Date.now() - 24 * 3600 * 1000;
  return prospects.filter((p) => p.last_sent_at && new Date(p.last_sent_at).getTime() >= cutoff).length;
}

export function summarize(r: TickResult): string {
  const parts = [
    `${r.discovered} discovered`,
    `${r.scansStarted} scans`,
    `${r.researched} researched`,
    r.sent
      ? `${r.sent} SENT`
      : r.autoSend
        // Sending is on and nothing went out, so the funnel stalled earlier.
        // Saying "auto_send off" here was simply false and sent people to
        // check a switch that was already flipped.
        ? `${r.dryRuns} drafted, 0 sent`
        : `${r.dryRuns} drafted (auto_send off)`,
  ];
  if (r.peopleRecorded) parts.push(`${r.peopleRecorded} people`);
  if (r.awaitingAuth.length) parts.push(`${r.awaitingAuth.length} waiting_for_auth`);
  // Only when something was charged. Printing "0 credits" on every idle tick
  // would bury the line that matters under the ones that cost nothing.
  if (r.creditsSpent) parts.push(`${r.creditsSpent} credits`);
  if (r.skipped.length) parts.push(`${r.skipped.length} skipped`);
  if (r.errors.length) parts.push(`${r.errors.length} errors`);
  return parts.join(", ");
}
