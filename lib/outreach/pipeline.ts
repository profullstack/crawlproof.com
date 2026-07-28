// The cold-outreach pipeline: the stages a prospect moves through, written
// once and driven from two places — the MCP tools (an agent stepping through
// it deliberately) and the cron runner (the same stages, unattended).
//
// Stages: discover → scan → research → draft → send → follow up.
//
// Every stage is resumable and idempotent, because the unattended caller runs
// on a tick and will re-enter mid-funnel constantly. Nothing here decides on
// its own to contact anybody: sending is always an explicit act by the
// caller, gated by lib/outreach/suppress.ts.

import crypto from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { z } from "zod/v4";
import { env } from "@/lib/env";
import { serviceClient } from "@/lib/supabase/service";
import { generateStructuredOutput } from "@/lib/lx/backendAi";
import { isAllowedTargetUrl, checkPerTargetLimit } from "@/lib/rateLimit";
import { DEFAULT_PROJECT_ENGINES } from "@/lib/credits";
import { newShareToken } from "@/lib/shareToken";
import { hostOf } from "@/lib/audit/share-card";
import { quoteFromFindings, formatUsd } from "@/lib/audit/quote";
import type { Finding } from "@/lib/audit/types";
import { isThirdPartyHost } from "@/lib/leadCampaign";
import { coldOutreachEmailHtml, sendColdOutreachEmail } from "@/lib/email";
import {
  CONTACT_PATHS,
  bestContact,
  contactLinksFrom,
  discoverContactEmails,
  explainSuppression,
  looksLikeEmail,
  normalizeEmail,
  normalizeHost,
  outreachSubject,
  stepGuidance,
  suppressionReason,
  unsupportedClaims,
  roleAddressGuesses,
  unsupportedCustomClaims,
  type ContactCandidate,
  type OutreachStep,
  type ProspectFacts,
} from "./cold";
import { isEmailSuppressed, marketingUnsubscribedAt, sendsInLast24h } from "./suppress";
import { resolvePostalAddress } from "./postalAddress";
import { findContactViaSearch } from "./contactFallback";
import { loadProjectMailbox } from "./senderMailbox";
import { loadRecipientContext, recipientContextPrompt } from "./recipientContext";
import { upsertContact } from "./contacts";
import { contactsFromDocuments, teamPageLinks } from "./documents";
import { newTrackToken, pixelHtml, pixelUrl } from "./openTracking";

export type ProspectRow = {
  id: string;
  project_id: string;
  owner_id: string;
  target_key: string;
  site_url: string | null;
  contact_email: string | null;
  contact_source: string | null;
  audit_id: string | null;
  report_token: string | null;
  score: number | null;
  score_kind: string | null;
  top_issues: string[];
  quote_usd: number | null;
  status: string;
  unsubscribe_token: string;
  last_sent_at: string | null;
  last_step: number;
  campaign_id: string | null;
};

export const PROSPECT_COLUMNS =
  "id, project_id, owner_id, target_key, site_url, contact_email, contact_source, audit_id, report_token, score, score_kind, top_issues, quote_usd, status, unsubscribe_token, last_sent_at, last_step, campaign_id";

type AuditRow = {
  id: string;
  target_url: string;
  status: string;
  score: number | null;
  engine: string;
  share_token: string | null;
  completed_at: string | null;
};

export function siteBase(): string {
  return env.siteUrl.replace(/\/$/, "");
}

export function aiClients() {
  return {
    anthropic: env.anthropicApiKey ? new Anthropic({ apiKey: env.anthropicApiKey }) : null,
    openai: env.openaiApiKey ? new OpenAI({ apiKey: env.openaiApiKey }) : null,
  };
}

export function factsOf(p: ProspectRow): ProspectFacts {
  return {
    host: p.target_key,
    score: p.score,
    kind: p.score_kind === "slop" ? "slop" : "aeo",
    topIssues: Array.isArray(p.top_issues) ? p.top_issues : [],
    reportUrl: p.report_token ? `${siteBase()}/r/${p.report_token}` : null,
    quoteUsd: p.quote_usd,
  };
}

/**
 * Is this site weak enough that "want us to fix it?" is a true statement?
 * The slop dial runs the other way — high is bad there — and conflating the
 * two pitches a rescue at the sites that least need one.
 */
export function isWeakEnough(input: {
  score: number | null;
  engine: string;
  maxScore: number;
}): boolean {
  if (input.score === null) return false;
  return input.engine === "slop" ? input.score >= 100 - input.maxScore : input.score <= input.maxScore;
}

export async function findingsFor(auditId: string): Promise<Finding[]> {
  const { data } = await serviceClient()
    .from("audit_findings")
    .select("section, check_key, status, title, detail, evidence, priority")
    .eq("audit_id", auditId)
    .order("priority", { ascending: true });
  return (data as Finding[] | null) ?? [];
}

/** Newest completed audit this user owns for the host, if any. */
export async function latestAuditForHost(userId: string, host: string): Promise<AuditRow | null> {
  const { data } = await serviceClient()
    .from("audits")
    .select("id, target_url, status, score, engine, share_token, completed_at")
    .eq("owner_id", userId)
    .eq("status", "complete")
    .order("completed_at", { ascending: false })
    .limit(300);
  const rows = (data as AuditRow[] | null) ?? [];
  return rows.find((r) => hostOf(r.target_url) === host) ?? null;
}

/** One lead in one project. Leads are project-scoped: the same business can
 * legitimately be a lead for two different projects. */
export async function loadProspect(projectId: string, key: string): Promise<ProspectRow | null> {
  const { data } = await serviceClient()
    .from("outreach_prospects")
    .select(PROSPECT_COLUMNS)
    .eq("project_id", projectId)
    .eq("channel", "email")
    .eq("target_key", normalizeHost(key))
    .maybeSingle();
  return (data as ProspectRow | null) ?? null;
}

/**
 * Kick off the free engines for a URL. Free on purpose: an unattended
 * campaign that spends credits per discovered domain would burn a balance on
 * prospects that turn out to be unreachable.
 */
export async function startFreeScan(input: {
  userId: string;
  url: string;
}): Promise<{ ok: true; scanRunId: string } | { ok: false; error: string }> {
  const check = isAllowedTargetUrl(input.url);
  if (!check.ok) return { ok: false, error: check.reason };
  if (!(await checkPerTargetLimit(check.url, input.userId))) {
    return { ok: false, error: "rate-limited (scanned moments ago)" };
  }
  const sb = serviceClient();
  const scanRunId = crypto.randomUUID();
  const inserts = DEFAULT_PROJECT_ENGINES.map((e) => ({
    target_url: check.url,
    project_id: null,
    owner_id: input.userId,
    status: "queued",
    share_token: newShareToken(),
    triggered_by: "manual",
    engine: e,
    scan_run_id: scanRunId,
  }));
  const { data, error } = await sb.from("audits").insert(inserts).select("id");
  if (error || !data) return { ok: false, error: error?.message ?? "insert failed" };
  if (env.workerUrl) {
    for (const r of data as { id: string }[]) {
      await fetch(`${env.workerUrl}/enqueue`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-worker-secret": env.workerSecret },
        body: JSON.stringify({ auditId: r.id }),
      }).catch(() => {});
    }
  }
  return { ok: true, scanRunId };
}

/**
 * Read the contact address the business publishes on its own site. No data
 * broker and no purchased list — which is both the ethical line and the
 * reason the address is current.
 *
 * Follows the site's own contact-ish links rather than only guessing paths.
 * Measured against nine real agency sites, guessing found 2/9: /contact 404s
 * where /contact-us works, and one address only existed on /privacy-policy.
 * The homepage's own nav knows where its contact page is; we don't.
 */
export async function findContact(host: string): Promise<ContactCandidate[]> {
  const found: ContactCandidate[] = [];
  const visited = new Set<string>();

  const fetchPage = async (url: string): Promise<string | null> => {
    if (visited.has(url) || visited.size >= 7) return null;
    visited.add(url);
    try {
      const res = await fetch(url, {
        headers: { "user-agent": "CrawlProofOutreach/1.0 (+https://crawlproof.com)" },
        signal: AbortSignal.timeout(8_000),
        redirect: "follow",
      });
      if (!res.ok) return null;
      return await res.text();
    } catch {
      return null;
    }
  };

  const collect = (html: string) => {
    found.push(...discoverContactEmails(html, host));
    return found.some((c) => c.sameDomain);
  };

  // Some hosts only answer on www; without the retry those sites yield
  // nothing at all rather than a missing address.
  const home = (await fetchPage(`https://${host}/`)) ?? (await fetchPage(`https://www.${host}/`));
  if (home) {
    if (collect(home)) return dedupe(found);

    for (const link of contactLinksFrom(home, `https://${host}/`)) {
      const html = await fetchPage(link);
      if (html && collect(html)) return dedupe(found);
    }
  }

  // Backstop for sites whose nav is rendered client-side, so the homepage
  // HTML carries no links to follow.
  for (const path of CONTACT_PATHS) {
    if (path === "/") continue;
    const html = await fetchPage(`https://${host}${path}`);
    if (html && collect(html)) break;
  }

  // The site's own pages had nothing. Two places remain that are still on
  // their domain and still free, and both are tried before the search
  // fallback that costs money and long before guessing an address.
  if (home && !found.some((c) => c.sameDomain)) {
    // A team page names people, and a named person's address beats info@ by
    // enough to be worth one more fetch.
    for (const link of teamPageLinks(home, `https://${host}/`)) {
      const html = await fetchPage(link);
      if (html && collect(html)) return dedupe(found);
    }

    // And the address is often only inside a linked document — a capability
    // statement or a media kit — on a page whose HTML says nothing.
    const docs = await contactsFromDocuments({
      html: home,
      sourceUrl: `https://${host}/`,
      host,
    });
    found.push(...docs.candidates);
  }

  return dedupe(found);
}

function dedupe(found: ContactCandidate[]): ContactCandidate[] {
  const seen = new Set<string>();
  return found.filter((c) => !seen.has(c.email) && seen.add(c.email));
}

export type ResearchResult =
  | { status: "scanning"; message: string }
  | { status: "researched"; prospect: ProspectRow; contact: ContactCandidate | null; candidates: ContactCandidate[]; quoteLabel: string }
  | { status: "error"; message: string };

/**
 * Attach evidence to a prospect: reuse or start a scan, pull the findings,
 * price the fix, find the address. Safe to call repeatedly — a prospect
 * mid-scan just answers "scanning" again.
 */
export async function researchProspect(input: {
  userId: string;
  projectId: string;
  url: string;
  campaignId?: string | null;
  contactEmail?: string | null;
  notes?: string | null;
  discoveredVia?: string | null;
  discoveryLabel?: string | null;
  /** Don't queue a scan for prospects we have no audit for. */
  skipScan?: boolean;
  /**
   * Shared, mutable allowance for the search-based contact fallback.
   *
   * The fallback spends SERP calls per prospect, so it is the most variable
   * cost in a tick. The budget is passed rather than counted internally
   * because it has to be shared across every prospect the tick researches.
   * Omitted means unlimited, which is what one-off manual research wants.
   */
  contactSearchBudget?: { remaining: number };
}): Promise<ResearchResult> {
  const check = isAllowedTargetUrl(input.url);
  if (!check.ok) return { status: "error", message: check.reason };
  const target = check.url;
  // normalizeHost, not hostOf: target_key is the dedupe key and the unique
  // index is over the plain column, so it must be lower-cased on the way in.
  const host = normalizeHost(target);

  if (isThirdPartyHost(host)) {
    return { status: "error", message: `${host} is a third-party platform, not a site someone owns.` };
  }
  if (await isEmailSuppressed(`x@${host}`)) {
    return { status: "error", message: `${host} is on the do-not-contact list.` };
  }

  const audit = await latestAuditForHost(input.userId, host);
  // A campaign that isn't pitching an audit has no use for a scan, and
  // scanning someone in order to email them about something else is both
  // wasted worker time and a poor look. Skipping it moves the prospect
  // straight to contact discovery instead of parking it on a scan that
  // nothing will ever read.
  if (!audit && input.skipScan) {
    return researchWithoutScan({ ...input, host, target });
  }
  if (!audit) {
    const started = await startFreeScan({ userId: input.userId, url: target });
    if (!started.ok) return { status: "error", message: started.error };
    // Record the prospect now so the funnel can see it waiting on a scan.
    await serviceClient()
      .from("outreach_prospects")
      .upsert(
        {
          project_id: input.projectId,
          owner_id: input.userId,
          channel: "email",
          target_key: host,
          site_url: target,
          campaign_id: input.campaignId ?? null,
          discovered_via: input.discoveredVia ?? null,
          discovery_label: input.discoveryLabel ?? null,
          status: "new",
        },
        { onConflict: "project_id,channel,target_key" },
      );
    return {
      status: "scanning",
      message: `Started a free scan of ${host} (${DEFAULT_PROJECT_ENGINES.join(", ")}). Re-run in ~30–60s.`,
    };
  }

  const findings = await findingsFor(audit.id);
  const problems = findings.filter((f) => f.status === "fail" || f.status === "warn");
  const topIssues = problems.slice(0, 5).map((f) => f.title);
  const quote = quoteFromFindings(findings);

  let candidates = input.contactEmail
    ? [
        {
          email: normalizeEmail(input.contactEmail),
          source: "manual" as const,
          sameDomain: normalizeEmail(input.contactEmail).endsWith(`@${host}`),
        },
      ]
    : await findContact(host);
  let contact = bestContact(candidates);

  // Same second step as the unscanned path: a scan we can talk about is
  // worth nothing if there is no address to send it to.
  const auditBudget = input.contactSearchBudget;
  if (!contact && (!auditBudget || auditBudget.remaining > 0)) {
    if (auditBudget) auditBudget.remaining -= 1;
    const viaSearch = await findContactViaSearch({ host, label: input.discoveryLabel });
    if (viaSearch.candidates.length) {
      candidates = [...candidates, ...viaSearch.candidates];
      contact = bestContact(candidates);
    }
  }

  // The same record the unscanned path writes. Missing it here is why the
  // shared contacts table held nine rows against seventy-seven addressable
  // leads: nearly all of them arrived through this branch, which wrote the
  // address onto the prospect and nowhere else.
  const scannedContactId = await recordContact({
    projectId: input.projectId,
    host,
    email: contact?.email ?? null,
    label: input.discoveryLabel,
    campaignId: input.campaignId,
    source: contact?.source === "manual" ? "manual" : contact?.source === "guess" ? "guess" : "page",
  });

  const { data, error } = await serviceClient()
    .from("outreach_prospects")
    .upsert(
      {
        project_id: input.projectId,
        owner_id: input.userId,
        channel: "email",
        target_key: host,
        site_url: target,
        campaign_id: input.campaignId ?? null,
        discovered_via: input.discoveredVia ?? null,
        discovery_label: input.discoveryLabel ?? null,
        contact_email: contact?.email ?? null,
        contact_source: contact?.source ?? null,
        contact_id: scannedContactId,
        audit_id: audit.id,
        report_token: audit.share_token,
        score: audit.score,
        score_kind: audit.engine === "slop" ? "slop" : "aeo",
        top_issues: topIssues,
        quote_usd: quote.cappedForScoping ? null : Math.round(quote.amountUsd),
        // Same reasoning as the unscanned path: the scan landed, the search
        // ran, and no address exists to send anything to.
        status: contact ? "researched" : "skipped",
        ...(input.notes ? { notes: input.notes } : {}),
      },
      { onConflict: "project_id,channel,target_key" },
    )
    .select(PROSPECT_COLUMNS)
    .maybeSingle();
  if (error || !data) {
    return { status: "error", message: error?.message ?? "Could not save the prospect." };
  }

  return {
    status: "researched",
    prospect: data as ProspectRow,
    contact,
    candidates,
    quoteLabel: quote.cappedForScoping
      ? `too large to auto-quote (${quote.issueCount} issues)`
      : `${formatUsd(quote.amountUsd)} (${quote.totalHours}h to reach ${quote.targetScore}/100)`,
  };
}

/**
 * Research a prospect without scanning it.
 *
 * All a non-audit campaign needs is a way to reach someone, so this does
 * contact discovery and stops. The prospect lands as "researched" with no
 * score and no findings, which is honest: nothing was measured, and the
 * draft path for these campaigns doesn't claim otherwise.
 */

/**
 * Write the person behind a prospect into the shared contact record.
 *
 * Resolves the organization from the project, because contacts are org-scoped
 * while prospects are project-scoped — that difference is the entire reason
 * this table exists.
 */
async function recordContact(input: {
  projectId: string;
  host: string;
  email: string | null;
  label?: string | null;
  campaignId?: string | null;
  source: "page" | "search" | "guess" | "manual";
}): Promise<string | null> {
  const sb = serviceClient();
  const { data: project } = await sb
    .from("projects")
    .select("organization_id")
    .eq("id", input.projectId)
    .maybeSingle();
  const organizationId = (project?.organization_id as string | null) ?? null;
  if (!organizationId) return null;

  // The campaign that found them is the best available statement of what
  // they are: someone found by "game designers in Austin" is a game
  // designer in Austin. It is the only niche the pipeline can know without
  // asking a model to guess one, and a list without a niche cannot be
  // segmented, which is most of what makes a list worth anything.
  let niche: string | null = null;
  if (input.campaignId) {
    const { data: campaign } = await sb
      .from("outreach_campaigns")
      .select("name")
      .eq("id", input.campaignId)
      .maybeSingle();
    niche = (campaign?.name as string | null) ?? null;
  }

  const res = await upsertContact({
    organizationId,
    source: input.source,
    fields: {
      email: input.email,
      host: input.host,
      // The discovery label is what the listing called them, which is a
      // company name far more often than a person's — so it is recorded as
      // one rather than guessed into full_name.
      companyName: input.label ?? null,
      companySite: `https://${input.host}`,
      niche,
    },
  });
  return res?.id ?? null;
}

async function researchWithoutScan(input: {
  userId: string;
  projectId: string;
  campaignId?: string | null;
  contactEmail?: string | null;
  notes?: string | null;
  discoveredVia?: string | null;
  discoveryLabel?: string | null;
  contactSearchBudget?: { remaining: number };
  host: string;
  target: string;
}): Promise<ResearchResult> {
  const { host, target } = input;
  let candidates = input.contactEmail
    ? [
        {
          email: normalizeEmail(input.contactEmail),
          source: "manual" as const,
          sameDomain: normalizeEmail(input.contactEmail).endsWith(`@${host}`),
        },
      ]
    : await findContact(host);
  let contact = bestContact(candidates);
  let fallbackNote: string | null = null;

  // The site published nothing reachable. Rather than park the prospect at
  // "new" forever, look the business up — plenty of portfolios hide contact
  // behind a form or an image, and the address exists somewhere else.
  const budget = input.contactSearchBudget;
  if (!contact && (!budget || budget.remaining > 0)) {
    if (budget) budget.remaining -= 1;
    const viaSearch = await findContactViaSearch({ host, label: input.discoveryLabel });
    if (viaSearch.candidates.length) {
      candidates = [...candidates, ...viaSearch.candidates];
      contact = bestContact(candidates);
    }
    fallbackNote = viaSearch.note;
  }

  // Last resort: a shared inbox this domain probably has. Only after both
  // the crawl and the search have found nothing, because a constructed
  // address bounces more often than a published one and bounces are charged
  // to the sender's reputation, not the guess.
  if (!contact) {
    const guessed = bestContact(roleAddressGuesses(host));
    if (guessed) {
      candidates = [...candidates, guessed];
      contact = guessed;
      fallbackNote = `no address published or findable — using the guessed shared inbox ${guessed.email}`;
    }
  }

  // Record the person before the prospect, so the prospect can point at
  // them. This is what stops the same human becoming a separate row in every
  // project that happens to find them.
  const contactId = await recordContact({
    projectId: input.projectId,
    host,
    email: contact?.email ?? null,
    label: input.discoveryLabel,
    campaignId: input.campaignId,
    source: contact?.source === "manual" ? "manual" : contact?.source === "guess" ? "guess" : "page",
  });

  const { data, error } = await serviceClient()
    .from("outreach_prospects")
    .upsert(
      {
        project_id: input.projectId,
        owner_id: input.userId,
        channel: "email",
        target_key: host,
        site_url: target,
        campaign_id: input.campaignId ?? null,
        discovered_via: input.discoveredVia ?? null,
        discovery_label: input.discoveryLabel ?? null,
        contact_email: contact?.email ?? null,
        contact_source: contact?.source ?? null,
        contact_id: contactId,
        // Crawled the site, then searched for the business, and still found
        // no address. There is nothing further to try, so it leaves the
        // funnel rather than sitting at "new" and being re-researched on
        // every tick for the life of the campaign.
        status: contact ? "researched" : "skipped",
        ...(input.notes
          ? { notes: input.notes }
          : { notes: contact ? null : (fallbackNote ?? "no contact address found") }),
      },
      { onConflict: "project_id,channel,target_key" },
    )
    .select(PROSPECT_COLUMNS)
    .maybeSingle();
  if (error || !data) {
    return { status: "error", message: error?.message ?? "Could not save the prospect." };
  }

  return {
    status: "researched",
    prospect: data as ProspectRow,
    contact,
    candidates,
    quoteLabel: "not scanned — this campaign doesn't pitch an audit",
  };
}

// ------------------------------------------------------------------- drafting

const DraftSchema = z.object({
  subject: z.string().describe("Subject line. States the finding; never a question, never fake familiarity."),
  body: z.string().describe("Plain-text email body, including a short sign-off."),
  evidence_used: z.array(z.string()).describe("Which supplied findings this draft cites."),
});

export const DRAFT_SYSTEM = `You write cold outreach email for CrawlProof, which scans websites for how they read to AI answer engines and fixes what it finds.

Hard rules, in order of importance:
1. Every factual claim about the recipient's website must come from the FINDINGS supplied to you. If a fact is not in the findings, you do not know it, and you may not state it.
2. Never imply a prior relationship. This person has never heard from us. No "following up", no "as discussed", no "thanks for your time".
3. No invented urgency, no fake deadlines, no invented traffic or revenue numbers, no "I was browsing your site and loved it".
4. Lead with the specific defect, named. "Your homepage has no meta description" beats "your SEO could be improved" every time.
5. Short. Under 120 words for a first contact. A cold email that needs scrolling does not get read.
6. Plain language. No "In today's digital landscape", "unlock", "leverage", "elevate", "game-changer", "delve", "reach out", "circle back", "I hope this email finds you well".
7. One ask, and make it the low-commitment one: look at the report. Never ask for a call in a first message.
8. Write like a person who ran a scan and thought the result was worth mentioning — because that is exactly what happened.`;

/**
 * A campaign's own pitch, for campaigns that aren't selling a CrawlProof scan.
 *
 * `facts` is what the draft is permitted to assert. It replaces scan findings
 * as the grounding set, so the honesty guarantee survives the change of
 * subject rather than being dropped along with it.
 */
export type CampaignPitch = {
  intro: string;
  ask?: string | null;
  facts: string[];
};

/** System prompt for a campaign pitching something other than a scan. */
export function customDraftSystem(pitch: CampaignPitch): string {
  return `You write one short cold email on behalf of the sender described below. You are not selling a website audit; write only the pitch described.

WHO IS WRITING AND WHY:
${pitch.intro}

SHAPE. Four short paragraphs, in this order, and nothing else:
1. One specific, checkable observation about the recipient, drawn only from what their own site says about itself. Name the actual thing they do. This is the sentence that decides whether the rest gets read, and a generic opening wastes it.
2. One sentence naming a problem the sender genuinely addresses and the recipient plausibly has. State it as a general observation, not as a diagnosis of them — you do not know their situation.
3. One or two sentences on what the sender offers, concretely. Name real specifics from the FACTS. "We help you grow" says nothing; naming the actual thing says everything.
4. One low-commitment ask${pitch.ask ? `: ${pitch.ask}` : ""}, then a plain sign-off with the sender's name.

Hard rules, in order of importance:
1. Every factual claim must come from the FACTS supplied to you, or from the recipient's own self-description quoted in the prompt. Invent no numbers, dates, durations, links, company names or credentials.
2. Never imply a prior relationship. They have never heard from the sender. No "following up", no "as discussed", no "thanks for your time".
3. The observation in paragraph 1 is an observation, not a compliment. "You focus on X" is right. "I love your work", "impressive product", "you're crushing it" are not — praise from a stranger reads as a form letter, because it is one.
4. No invented urgency, no fake deadlines, no flattery about work you have not seen.
5. Under 150 words. Cold email that needs scrolling does not get read.
6. Plain language. No "In today's digital landscape", "unlock", "leverage", "elevate", "game-changer", "delve", "reach out", "circle back", "I hope this email finds you well".
7. One ask, and make it small. Offer to send more, not to take an hour of their time. Never ask for a call in a first message.
8. The subject line names the recipient's own thing and states the actual topic. Do not promise something the body does not deliver — a subject that says "quick question" with no question in it is a small lie, and the reply it earns is owed to the trick rather than the offer.
9. Write like one person emailing another, because that is what this is.`;
}

export type DraftResult =
  | { ok: true; subject: string; body: string; evidenceUsed: string[] }
  | { ok: false; problems: string[] };

export async function draftEmail(input: {
  prospect: ProspectRow;
  step: OutreachStep;
  angle?: string | null;
  sender?: string | null;
  /** Set for a custom campaign; omitted means the CrawlProof audit pitch. */
  pitch?: CampaignPitch | null;
}): Promise<DraftResult> {
  if (input.pitch) return draftCustomEmail({ ...input, pitch: input.pitch });

  const facts = factsOf(input.prospect);
  if (!facts.topIssues.length && facts.score === null) {
    return { ok: false, problems: ["no findings and no score on file — nothing truthful to say"] };
  }
  const { anthropic, openai } = aiClients();
  if (!anthropic && !openai) {
    return { ok: false, problems: ["no AI provider configured (ANTHROPIC_API_KEY / OPENAI_API_KEY)"] };
  }

  const findings = input.prospect.audit_id ? await findingsFor(input.prospect.audit_id) : [];
  const detailed = findings
    .filter((f) => f.status === "fail" || f.status === "warn")
    .slice(0, 8)
    .map((f) => `- ${f.title}${f.detail ? ` — ${f.detail}` : ""}`);

  const userPrompt = [
    `Recipient's website: ${facts.host}`,
    facts.score !== null
      ? `Scan score: ${facts.score}/100 (${facts.kind === "slop" ? "carelessness scan — HIGHER is worse" : "AI answer-engine scan — HIGHER is better"})`
      : "Scan score: none — do not cite a score.",
    "",
    "FINDINGS (the only facts you may state about their site):",
    ...(detailed.length ? detailed : facts.topIssues.map((t) => `- ${t}`)),
    "",
    facts.reportUrl
      ? `Their full report is at ${facts.reportUrl} — the caller renders it as a button, so say "the full report" rather than pasting the URL.`
      : "There is no shareable report link. Do not mention a report.",
    facts.quoteUsd
      ? `If the message mentions cost at all, the honest number for fixing everything found is ${formatUsd(facts.quoteUsd)}. Mentioning it is optional.`
      : "",
    "",
    `SEQUENCE POSITION: ${stepGuidance(input.step)}`,
    input.angle ? `Emphasis requested: ${input.angle}` : "",
    `Sign off as: ${input.sender ?? "the CrawlProof team"}`,
  ]
    .filter(Boolean)
    .join("\n");

  let output: { subject: string; body: string; evidence_used: string[] };
  try {
    const res = await generateStructuredOutput({
      name: "cold_outreach_draft",
      schema: DraftSchema,
      system: DRAFT_SYSTEM,
      user: userPrompt,
      anthropic,
      openai,
      preference: env.backendAiProvider,
      anthropicModel: "claude-haiku-4-5-20251001",
      openaiModel: env.backendAiOpenaiModel,
      maxTokens: 900,
      anthropicEffort: false,
    });
    output = res.output;
  } catch (err) {
    return { ok: false, problems: [`generation failed: ${err instanceof Error ? err.message : "unknown"}`] };
  }

  // The model is the least trustworthy part of this pipeline, so its output
  // is checked against the same facts it was handed.
  const problems = unsupportedClaims(output.body, facts);
  if (problems.length) return { ok: false, problems };

  return {
    ok: true,
    subject: output.subject?.trim() || outreachSubject(facts, input.step),
    body: output.body.trim(),
    evidenceUsed: output.evidence_used ?? [],
  };
}

/**
 * Draft for a campaign pitching something other than a scan.
 *
 * Structurally the same as the audit path — build a prompt, generate, then
 * refuse to trust the result — but grounded in the campaign's declared facts.
 * Nothing about the recipient's site is supplied, because nothing about it is
 * known: a custom campaign doesn't scan anyone.
 */
async function draftCustomEmail(input: {
  prospect: ProspectRow;
  step: OutreachStep;
  angle?: string | null;
  sender?: string | null;
  pitch: CampaignPitch;
}): Promise<DraftResult> {
  const facts = input.pitch.facts.map((f) => f.trim()).filter(Boolean);
  if (!input.pitch.intro.trim()) {
    return { ok: false, problems: ["the campaign has no pitch description — nothing to say"] };
  }
  if (!facts.length) {
    return {
      ok: false,
      problems: [
        "the campaign declares no facts, so there is nothing the draft would be allowed to state",
      ],
    };
  }

  const { anthropic, openai } = aiClients();
  if (!anthropic && !openai) {
    return { ok: false, problems: ["no AI provider configured (ANTHROPIC_API_KEY / OPENAI_API_KEY)"] };
  }

  const host = normalizeHost(input.prospect.site_url ?? input.prospect.target_key);
  // Paragraph 1 of the shape above needs something true to say. Without it
  // the model either opens generically or invents a detail, so the site's
  // own words are fetched and quoted rather than guessed at.
  const recipient = await loadRecipientContext(host);
  const userPrompt = [
    recipientContextPrompt(recipient, host),
    "",
    "FACTS (the only things you may state):",
    ...facts.map((f) => `- ${f}`),
    "",
    `SEQUENCE POSITION: ${stepGuidance(input.step)}`,
    input.pitch.ask ? `The ask: ${input.pitch.ask}` : "",
    input.angle ? `Emphasis requested: ${input.angle}` : "",
    input.sender ? `Sign off as: ${input.sender}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  let output: { subject: string; body: string; evidence_used: string[] };
  try {
    const res = await generateStructuredOutput({
      name: "custom_outreach_draft",
      schema: DraftSchema,
      system: customDraftSystem({ ...input.pitch, facts }),
      user: userPrompt,
      anthropic,
      openai,
      preference: env.backendAiProvider,
      anthropicModel: "claude-haiku-4-5-20251001",
      openaiModel: env.backendAiOpenaiModel,
      maxTokens: 900,
      anthropicEffort: false,
    });
    output = res.output;
  } catch (err) {
    return { ok: false, problems: [`generation failed: ${err instanceof Error ? err.message : "unknown"}`] };
  }

  // Facts, plus the intro and ask — everything the operator authored counts
  // as grounded, or an ask that names a URL makes its own draft invalid.
  const problems = unsupportedCustomClaims(output.body, [
    ...facts,
    input.pitch.intro,
    input.pitch.ask ?? "",
  ]);
  if (problems.length) return { ok: false, problems };

  const subject = output.subject?.trim();
  if (!subject) return { ok: false, problems: ["the draft came back with no subject"] };

  return {
    ok: true,
    subject,
    body: output.body.trim(),
    evidenceUsed: output.evidence_used ?? [],
  };
}

// -------------------------------------------------------------------- sending

export type SendOutcome =
  | { ok: true; dryRun: boolean; to: string; sentToday: number }
  | { ok: false; reason: string };

/**
 * The only function in the codebase that puts a cold email on the wire.
 * Everything protective lives here rather than in the callers, so a new
 * caller cannot forget it.
 */
export async function sendProspectEmail(input: {
  userId: string;
  prospect: ProspectRow;
  subject: string;
  body: string;
  step: OutreachStep;
  campaign: string;
  to?: string | null;
  replyTo?: string | null;
  dryRun: boolean;
}): Promise<SendOutcome> {
  const to = normalizeEmail(input.to ?? input.prospect.contact_email ?? "");
  if (!looksLikeEmail(to)) return { ok: false, reason: "no usable recipient address" };

  const sb = serviceClient();
  const [suppressed, unsubAt, sentToday, prior] = await Promise.all([
    isEmailSuppressed(to),
    marketingUnsubscribedAt(to),
    sendsInLast24h({ ownerId: input.userId, channels: ["email"] }),
    sb
      .from("outreach_sends")
      .select("id")
      .eq("owner_id", input.userId)
      .eq("channel", "email")
      .eq("campaign", input.campaign)
      .eq("step", input.step)
      .eq("dry_run", false)
      .ilike("recipient", to)
      .limit(1),
  ]);

  const reason = suppressionReason({
    email: to,
    suppressed,
    unsubscribedAt: unsubAt,
    alreadyContacted: ((prior.data as unknown[] | null) ?? []).length > 0,
    sentToday,
    dailyCap: env.outreachDailyCap,
  });
  if (reason) return { ok: false, reason: explainSuppression(reason) };

  const facts = factsOf(input.prospect);
  const claims = unsupportedClaims(input.body, facts);
  if (claims.length) return { ok: false, reason: `unsupported claims: ${claims.join("; ")}` };

  // CAN-SPAM requires a physical postal address in commercial email. It is
  // resolved per project (project → org → account → env) rather than read
  // from one global env var, so an agency signs each client's outreach with
  // that client's address.
  const postal = await resolvePostalAddress({
    projectId: input.prospect.project_id,
    ownerId: input.userId,
  });
  if (!input.dryRun && !postal.address) {
    return {
      ok: false,
      reason:
        "no sender postal address is set — CAN-SPAM requires one in commercial email. Add it on the Leads page or in Settings",
    };
  }

  const unsubscribeUrl = `${siteBase()}/unsubscribe/${input.prospect.unsubscribe_token}`;
  // Minted before the send, because the token has to be inside the message
  // that goes out — it cannot be attached to the row afterwards. Dry runs get
  // none: nothing was delivered, so nothing can open it.
  const trackToken = input.dryRun ? null : newTrackToken();
  let failed: string | null = null;
  // Defaults to the shared sender; a connected mailbox overrides it so the
  // pitch arrives from the user's own address.
  let provider = "resend";
  // Recorded so a reply naming it in In-Reply-To can be matched to this exact
  // send rather than inferred from the sender's domain.
  let providerMessageId: string | null = null;
  if (!input.dryRun) {
    const mailbox = await loadProjectMailbox(input.prospect.project_id);
    const res = await sendColdOutreachEmail({
      to,
      subject: input.subject,
      html: coldOutreachEmailHtml({
        host: facts.host,
        bodyText: input.body,
        reportUrl: facts.reportUrl,
        unsubscribeUrl,
        postalAddress: postal.address ?? "",
        trackingPixel: trackToken ? pixelHtml(pixelUrl(siteBase(), trackToken)) : null,
      }),
      unsubscribeUrl,
      replyTo: input.replyTo ?? undefined,
      mailbox,
    });
    provider = res.provider ?? "resend";
    providerMessageId = res.messageId ?? null;
    if (!res.sent) failed = res.error ?? "send failed";
  }

  await sb.from("outreach_sends").insert({
    project_id: input.prospect.project_id,
    owner_id: input.userId,
    prospect_id: input.prospect.id,
    channel: "email",
    campaign: input.campaign,
    step: input.step,
    recipient: to,
    subject: input.subject,
    body: input.body,
    target_url: input.prospect.site_url,
    provider: input.dryRun ? "dry-run" : provider,
    provider_message_id: providerMessageId,
    dry_run: input.dryRun || !!failed,
    // Only on a send that actually left. A token on a failed send would sit
    // in the table waiting for an open that cannot happen.
    track_token: failed ? null : trackToken,
  });

  if (failed) return { ok: false, reason: failed };

  if (!input.dryRun) {
    await sb
      .from("outreach_prospects")
      .update({
        status: "contacted",
        last_sent_at: new Date().toISOString(),
        last_step: input.step,
      })
      .eq("id", input.prospect.id);
  }

  return { ok: true, dryRun: input.dryRun, to, sentToday };
}
