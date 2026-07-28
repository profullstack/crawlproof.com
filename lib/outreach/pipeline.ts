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
  unsupportedCustomClaims,
  type ContactCandidate,
  type OutreachStep,
  type ProspectFacts,
} from "./cold";
import { isEmailSuppressed, marketingUnsubscribedAt, sendsInLast24h } from "./suppress";
import { resolvePostalAddress } from "./postalAddress";
import { findContactViaSearch } from "./contactFallback";
import { loadProjectMailbox } from "./senderMailbox";

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
  if (!contact) {
    const viaSearch = await findContactViaSearch({ host, label: input.discoveryLabel });
    if (viaSearch.candidates.length) {
      candidates = [...candidates, ...viaSearch.candidates];
      contact = bestContact(candidates);
    }
  }

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
async function researchWithoutScan(input: {
  userId: string;
  projectId: string;
  campaignId?: string | null;
  contactEmail?: string | null;
  notes?: string | null;
  discoveredVia?: string | null;
  discoveryLabel?: string | null;
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
  if (!contact) {
    const viaSearch = await findContactViaSearch({ host, label: input.discoveryLabel });
    if (viaSearch.candidates.length) {
      candidates = [...candidates, ...viaSearch.candidates];
      contact = bestContact(candidates);
    }
    fallbackNote = viaSearch.note;
  }

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
  return `You write cold outreach email on behalf of the sender described below. You are not selling a website audit; write only the pitch described.

WHO IS WRITING AND WHY:
${pitch.intro}

Hard rules, in order of importance:
1. Every factual claim must come from the FACTS supplied to you. If something is not in the facts, you do not know it, and you may not state it. Invent no numbers, dates, durations, links, company names or credentials.
2. Say nothing about the recipient's business as fact. You have not researched them. You may say why you are writing to someone like them, not what they are doing wrong.
3. Never imply a prior relationship. They have never heard from the sender. No "following up", no "as discussed", no "thanks for your time".
4. No invented urgency, no fake deadlines, no flattery about work you have not seen.
5. Short. Under 120 words for a first contact.
6. Plain language. No "In today's digital landscape", "unlock", "leverage", "elevate", "game-changer", "delve", "reach out", "circle back", "I hope this email finds you well".
7. One ask${pitch.ask ? `, and it is this: ${pitch.ask}` : ", and make it low-commitment"}. Never ask for a call in a first message.
8. Write like one person emailing another, because that is what this is.`;
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
  const userPrompt = [
    `Recipient: someone at ${host}. You know nothing else about them — do not characterise their work, their site, or their needs as fact.`,
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

  const problems = unsupportedCustomClaims(output.body, facts);
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
  let failed: string | null = null;
  // Defaults to the shared sender; a connected mailbox overrides it so the
  // pitch arrives from the user's own address.
  let provider = "resend";
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
      }),
      unsubscribeUrl,
      replyTo: input.replyTo ?? undefined,
      mailbox,
    });
    provider = res.provider ?? "resend";
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
    dry_run: input.dryRun || !!failed,
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
