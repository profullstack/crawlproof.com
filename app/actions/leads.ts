"use server";

import { revalidatePath } from "next/cache";
import { serviceClient } from "@/lib/supabase/service";
import { requireProjectAccess } from "@/lib/lx/currentSite";
import { env } from "@/lib/env";
import { normalizeHost, type OutreachStep } from "@/lib/outreach/cold";
import {
  PROSPECT_COLUMNS,
  draftEmail,
  researchProspect,
  sendProspectEmail,
  type ProspectRow,
} from "@/lib/outreach/pipeline";
import { addSuppression } from "@/lib/outreach/suppress";
import { loadAddressSettings } from "@/lib/outreach/postalAddress";
import { discoverProspects } from "@/lib/outreach/discover";
import { recordDiscoveredPeople } from "@/lib/outreach/contacts";
import { generatePitch } from "@/lib/outreach/generatePitch";
import { leadRunBilling, manualRunPrice } from "@/lib/outreach/billing";
import { runEmailCampaignTick, CAMPAIGN_COLUMNS, summarize, type CampaignRow } from "@/lib/outreach/runner";

type Ok<T = Record<string, never>> = { ok: true } & T;
type Err = { ok: false; error: string };

/**
 * Leads live under a project, so every action starts by proving the caller
 * may act on that project. Viewers are excluded: sending mail on a project's
 * behalf is not a read.
 */
async function requireLeadAccess(
  projectId: string,
): Promise<{ ok: true; userId: string } | Err> {
  if (!projectId) return { ok: false, error: "Missing project." };
  const access = await requireProjectAccess(projectId);
  if (!access.ok) return { ok: false, error: access.error };
  if (access.isViewer) return { ok: false, error: "Viewers can't run outreach on this project." };
  return { ok: true, userId: access.userId };
}

/**
 * Everything here goes through the service client after the access check
 * above, rather than through RLS. The outreach tables have no policies at
 * all, so a browser session cannot touch them directly — which is what keeps
 * outreach_sends an honest record of what was sent to whom.
 */
async function projectProspect(projectId: string, host: string): Promise<ProspectRow | null> {
  const { data } = await serviceClient()
    .from("outreach_prospects")
    .select(PROSPECT_COLUMNS)
    .eq("project_id", projectId)
    .eq("target_key", normalizeHost(host))
    .maybeSingle();
  return (data as ProspectRow | null) ?? null;
}

function leadsPath(projectId: string): string {
  return `/projects/${projectId}/leads`;
}

/** Find businesses and queue a free scan for each — the "add leads" button. */
export async function findLeadsAction(input: {
  projectId: string;
  query?: string;
  seedUrl?: string;
  limit?: number;
}): Promise<Ok<{ added: number; scanning: number; note: string }> | Err> {
  const auth = await requireLeadAccess(input.projectId);
  if (!auth.ok) return auth;
  if (!input.query?.trim() && !input.seedUrl?.trim()) {
    return { ok: false, error: "Enter a search query or a directory URL." };
  }

  // A directory can list hundreds of businesses; capping a one-shot run at
  // ten meant the form reported a fraction of a page and looked broken.
  const limit = Math.min(input.limit ?? 100, 1000);
  // Priced per hundred leads asked for. A thousand-lead run does ten times the
  // paid search of a hundred-lead one, so charging both the same would make
  // the largest runs the cheapest place to spend our money.
  const price = manualRunPrice(limit);
  const billing = leadRunBilling(auth.userId, price.credits);
  if (!(await billing.authorize())) {
    return {
      ok: false,
      error: `Finding up to ${limit} leads costs ${price.credits} credits; not enough balance. Buy credits in Billing.`,
    };
  }
  // Contact lookup is the part that costs money — up to two SERP calls per
  // prospect that publishes no address — so the ceiling is what the run paid
  // for rather than an unbounded bill.
  const contactSearchBudget = { remaining: price.contactSearches };
  const { data: projectRow } = await serviceClient()
    .from("projects")
    .select("organization_id")
    .eq("id", input.projectId)
    .maybeSingle();
  const orgId = (projectRow?.organization_id as string | null) ?? null;

  const found = await discoverProspects({
    queries: input.query?.trim() ? [input.query.trim()] : [],
    seedUrls: input.seedUrl?.trim() ? [input.seedUrl.trim()] : [],
    limit,
  });
  // People named on the pages we opened are recorded even when no address
  // was found for them. A directory gives a name, a title and a LinkedIn
  // profile and withholds the email; discarding that until an address turns
  // up means rediscovering the same person on every run.
  // The same recorder the campaign runner uses. Two copies of this is what
  // let the runner quietly stop recording people at all.
  const peopleRecorded = await recordDiscoveredPeople({
    organizationId: orgId,
    people: found.people ?? [],
  });

  if (!found.prospects.length && !peopleRecorded) {
    // Nothing to show for it, so nothing to charge for it.
    await billing.refund();
    return { ok: false, error: found.errors.join("; ") || "No businesses found for that search." };
  }

  let added = 0;
  const scanning = 0;
  for (const candidate of found.prospects.slice(0, limit)) {
    const res = await researchProspect({
      userId: auth.userId,
      projectId: input.projectId,
      url: candidate.url,
      discoveredVia: candidate.via,
      discoveryLabel: candidate.label,
      contactSearchBudget,
      // Finding leads for a project does not scan them. The scan exists to
      // supply findings for the CrawlProof audit pitch, and firing one at
      // every discovered business spends worker time on evidence nobody is
      // going to cite — and points a scanner at people who only turned up in
      // a search. Campaigns that do pitch an audit turn scanning back on
      // explicitly.
      skipScan: true,
    });
    if (res.status === "researched") {
      added += 1;
    }
  }

  revalidatePath(leadsPath(input.projectId));
  return {
    ok: true,
    added,
    scanning,
    note: peopleRecorded
      ? `${added} leads added, ${peopleRecorded} people recorded — ${price.credits} credits.`
      : `${added} leads added — ${price.credits} credits.`,
  };
}

/**
 * Record what actually came of a lead.
 *
 * Nothing else in the pipeline can set these. A send is observable, a reply
 * is not — the sending mailbox knows, and until reply detection reads it,
 * only the user does. Without a way to record the outcome the funnel can
 * only ever report sends, and a reply rate that is structurally zero is
 * worse than no reply rate at all.
 */
/**
 * Turn a rough goal into the three pitch fields.
 *
 * The form asks for precisely-scoped inputs and the grounding guard refuses
 * drafts that stray outside them, which is a lot to ask of someone who just
 * wants to describe what they are doing. This does the splitting, and
 * deliberately does not author: a fact invented here is one the guard will
 * pass straight through to a stranger, because drafts are checked against
 * this output rather than against reality.
 */
export async function generatePitchAction(input: {
  projectId: string;
  goal: string;
  senderName?: string;
}): Promise<Ok<{ intro: string; ask: string; facts: string[] }> | Err> {
  const auth = await requireLeadAccess(input.projectId);
  if (!auth.ok) return auth;

  const res = await generatePitch({ goal: input.goal, senderName: input.senderName });
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true, ...res.pitch };
}

export async function markLeadOutcomeAction(input: {
  projectId: string;
  host: string;
  outcome: "replied" | "won" | "lost" | "contacted";
}): Promise<Ok<{ note: string }> | Err> {
  const auth = await requireLeadAccess(input.projectId);
  if (!auth.ok) return auth;

  const prospect = await projectProspect(input.projectId, input.host);
  if (!prospect) return { ok: false, error: "That lead isn't in this project." };

  const { error } = await serviceClient()
    .from("outreach_prospects")
    .update({ status: input.outcome })
    .eq("id", prospect.id);
  if (error) return { ok: false, error: error.message };

  revalidatePath(leadsPath(input.projectId));
  return { ok: true, note: `Marked ${input.host} as ${input.outcome}.` };
}

/** Re-run research on one lead: pick up a finished scan, refresh the contact. */
export async function researchLeadAction(input: {
  projectId: string;
  host: string;
  contactEmail?: string;
}): Promise<Ok<{ note: string }> | Err> {
  const auth = await requireLeadAccess(input.projectId);
  if (!auth.ok) return auth;
  const prospect = await projectProspect(input.projectId, input.host);
  const url = prospect?.site_url ?? `https://${normalizeHost(input.host)}`;

  const res = await researchProspect({
    userId: auth.userId,
    projectId: input.projectId,
    url,
    campaignId: prospect?.campaign_id ?? null,
    contactEmail: input.contactEmail,
  });
  if (res.status === "error") return { ok: false, error: res.message };
  revalidatePath(leadsPath(input.projectId));
  return {
    ok: true,
    note:
      res.status === "scanning"
        ? res.message
        : `${res.prospect.target_key}: ${res.prospect.score ?? "—"}/100, ${
            res.contact ? `contact ${res.contact.email}` : "no contact address published"
          }.`,
  };
}

/**
 * Re-run research on every lead still waiting on a scan.
 *
 * The gap this fills: discovery queues a free scan and returns immediately,
 * so a new lead is created with no findings and no contact. Something has to
 * come back once the scan lands. A campaign tick does that for its own
 * leads; leads added by hand from the finder had nothing, so they sat at
 * "new" forever with "no contact address found" next to a finished scan.
 */
export async function refreshLeadsAction(input: {
  projectId: string;
  limit?: number;
}): Promise<Ok<{ note: string; researched: number; contacts: number }> | Err> {
  const auth = await requireLeadAccess(input.projectId);
  if (!auth.ok) return auth;

  const { data } = await serviceClient()
    .from("outreach_prospects")
    .select("target_key, site_url, campaign_id, status, contact_email")
    .eq("project_id", input.projectId)
    .eq("channel", "email")
    .in("status", ["new", "researched"])
    .order("created_at", { ascending: true })
    .limit(Math.min(input.limit ?? 25, 50));

  const rows = (data as Array<{
    target_key: string;
    site_url: string | null;
    campaign_id: string | null;
    status: string;
    contact_email: string | null;
  }> | null) ?? [];

  // Nothing to do for leads that already have what they need.
  const pending = rows.filter((r) => r.status === "new" || !r.contact_email);
  if (!pending.length) {
    return { ok: true, researched: 0, contacts: 0, note: "Every lead is already researched." };
  }

  let researched = 0;
  let contacts = 0;
  let stillScanning = 0;
  for (const row of pending) {
    const res = await researchProspect({
      userId: auth.userId,
      projectId: input.projectId,
      url: row.site_url ?? `https://${row.target_key}`,
      campaignId: row.campaign_id,
    });
    if (res.status === "researched") {
      researched += 1;
      if (res.contact) contacts += 1;
    } else if (res.status === "scanning") {
      stillScanning += 1;
    }
  }

  const parts = [`${researched} researched`, `${contacts} with a contact address`];
  if (stillScanning) parts.push(`${stillScanning} still scanning`);
  return { ok: true, researched, contacts, note: parts.join(", ") + "." };
}

export async function draftLeadAction(input: {
  projectId: string;
  host: string;
  step?: number;
  angle?: string;
}): Promise<Ok<{ subject: string; body: string; to: string | null }> | Err> {
  const auth = await requireLeadAccess(input.projectId);
  if (!auth.ok) return auth;
  const prospect = await projectProspect(input.projectId, input.host);
  if (!prospect) return { ok: false, error: "Lead not found." };

  const step = Math.min(Math.max(input.step ?? (prospect.last_step || 0) + 1, 1), 3) as OutreachStep;
  const draft = await draftEmail({ prospect, step, angle: input.angle });
  if (!draft.ok) return { ok: false, error: draft.problems.join("; ") };

  await serviceClient()
    .from("outreach_prospects")
    .update({ status: prospect.status === "new" ? "drafted" : prospect.status })
    .eq("id", prospect.id);
  revalidatePath(leadsPath(input.projectId));
  return { ok: true, subject: draft.subject, body: draft.body, to: prospect.contact_email };
}

export async function sendLeadAction(input: {
  projectId: string;
  host: string;
  subject: string;
  body: string;
  step?: number;
  replyTo?: string;
  dryRun?: boolean;
}): Promise<Ok<{ note: string; dryRun: boolean }> | Err> {
  const auth = await requireLeadAccess(input.projectId);
  if (!auth.ok) return auth;
  const prospect = await projectProspect(input.projectId, input.host);
  if (!prospect) return { ok: false, error: "Lead not found." };

  const dryRun = input.dryRun !== false;
  const step = Math.min(Math.max(input.step ?? 1, 1), 3) as OutreachStep;
  const outcome = await sendProspectEmail({
    userId: auth.userId,
    prospect,
    subject: input.subject,
    body: input.body,
    step,
    campaign: "leads-ui",
    replyTo: input.replyTo,
    dryRun,
  });
  if (!outcome.ok) return { ok: false, error: outcome.reason };

  revalidatePath(leadsPath(input.projectId));
  return {
    ok: true,
    dryRun: outcome.dryRun,
    note: outcome.dryRun
      ? `Dry run OK — nothing sent. ${outcome.sentToday}/${env.outreachDailyCap} used today.`
      : `Sent to ${outcome.to}. ${outcome.sentToday + 1}/${env.outreachDailyCap} used today.`,
  };
}

export async function suppressLeadAction(input: {
  projectId: string;
  value: string;
  scope?: "email" | "domain" | "reddit_user";
}): Promise<Ok<{ note: string }> | Err> {
  const auth = await requireLeadAccess(input.projectId);
  if (!auth.ok) return auth;
  const scope = input.scope ?? (input.value.includes("@") ? "email" : "domain");
  const res = await addSuppression({
    scope,
    value: input.value,
    reason: "added from the Leads page",
    addedBy: auth.userId,
  });
  if (!res.ok) return { ok: false, error: res.error ?? "Could not add the suppression." };

  // Take them out of every funnel, not just this project's — the suppression
  // list is global, so leaving a live row in a sibling project would have the
  // next tick draft for someone who just asked to be left alone.
  const sb = serviceClient();
  if (scope === "domain") {
    await sb
      .from("outreach_prospects")
      .update({ status: "skipped", notes: "do-not-contact" })
      .eq("target_key", normalizeHost(input.value));
  } else if (scope === "email") {
    await sb
      .from("outreach_prospects")
      .update({ status: "skipped", notes: "do-not-contact" })
      .ilike("contact_email", input.value);
  }

  revalidatePath(leadsPath(input.projectId));
  return { ok: true, note: `${input.value} will not be contacted again (${scope}).` };
}

/**
 * Save the CAN-SPAM postal address at one of the three levels.
 *
 * `scope: "account"` is the global one — set it once and every project can
 * pull it in with a click. Only the org owner may write the org-level
 * address, since it signs mail for everybody in it.
 */
export async function savePostalAddressAction(input: {
  projectId: string;
  scope: "project" | "organization" | "account";
  address: string;
}): Promise<Ok<{ note: string }> | Err> {
  const auth = await requireLeadAccess(input.projectId);
  if (!auth.ok) return auth;

  // Empty clears the level, which is how you fall back to a broader one.
  const address = input.address.trim() || null;
  const sb = serviceClient();

  if (input.scope === "account") {
    const { error } = await sb
      .from("profiles")
      .update({ outreach_postal_address: address })
      .eq("id", auth.userId);
    if (error) return { ok: false, error: error.message };
  } else if (input.scope === "organization") {
    const { data: project } = await sb
      .from("projects")
      .select("organization_id")
      .eq("id", input.projectId)
      .maybeSingle();
    const orgId = (project?.organization_id as string | null) ?? null;
    if (!orgId) return { ok: false, error: "This project isn't in an organization." };
    const { data: org } = await sb
      .from("organizations")
      .select("owner_id")
      .eq("id", orgId)
      .maybeSingle();
    if ((org?.owner_id as string | null) !== auth.userId) {
      return { ok: false, error: "Only the organization owner can set the org-wide address." };
    }
    const { error } = await sb
      .from("organizations")
      .update({ outreach_postal_address: address })
      .eq("id", orgId);
    if (error) return { ok: false, error: error.message };
  } else {
    const { error } = await sb
      .from("projects")
      .update({ outreach_postal_address: address })
      .eq("id", input.projectId);
    if (error) return { ok: false, error: error.message };
  }

  revalidatePath(leadsPath(input.projectId));
  const where =
    input.scope === "account" ? "your account" : input.scope === "organization" ? "the organization" : "this project";
  return {
    ok: true,
    note: address ? `Saved to ${where}.` : `Cleared the address on ${where}.`,
  };
}

/** One-click "use my account address here" — copies down a level. */
export async function importPostalAddressAction(input: {
  projectId: string;
  from: "account" | "organization";
}): Promise<Ok<{ note: string; address: string }> | Err> {
  const auth = await requireLeadAccess(input.projectId);
  if (!auth.ok) return auth;

  const settings = await loadAddressSettings({ projectId: input.projectId, ownerId: auth.userId });
  const source = input.from === "account" ? settings.levels.account : settings.levels.organization;
  if (!source) {
    return {
      ok: false,
      error:
        input.from === "account"
          ? "No address saved on your account yet — set one first."
          : "No org-wide address saved yet.",
    };
  }

  const { error } = await serviceClient()
    .from("projects")
    .update({ outreach_postal_address: source })
    .eq("id", input.projectId);
  if (error) return { ok: false, error: error.message };

  revalidatePath(leadsPath(input.projectId));
  return { ok: true, address: source, note: `Imported from ${input.from === "account" ? "your account" : "the organization"}.` };
}

export async function saveCampaignAction(input: {
  projectId: string;
  name: string;
  queries: string;
  seedUrls: string;
  maxScore: number;
  dailySendLimit: number;
  autoSend: boolean;
  active: boolean;
  angle?: string;
  senderName?: string;
  replyTo?: string;
  pitchMode?: "audit" | "custom";
  pitchIntro?: string;
  pitchAsk?: string;
  pitchFacts?: string;
  scanProspects?: boolean;
}): Promise<Ok<{ note: string }> | Err> {
  const auth = await requireLeadAccess(input.projectId);
  if (!auth.ok) return auth;
  if (!input.name.trim()) return { ok: false, error: "Give the campaign a name." };

  const queries = input.queries.split("\n").map((s) => s.trim()).filter(Boolean);
  const seedUrls = input.seedUrls.split("\n").map((s) => s.trim()).filter(Boolean);
  if (!queries.length && !seedUrls.length) {
    return { ok: false, error: "A campaign needs at least one search query or directory URL." };
  }
  const pitchMode = input.pitchMode ?? "audit";
  const pitchFacts = (input.pitchFacts ?? "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  if (pitchMode === "custom") {
    // The same bar the audit pitch holds itself to: without a description
    // and some declared facts there is nothing truthful for a draft to say,
    // and the grounding guard would reject every draft anyway.
    if (!input.pitchIntro?.trim()) {
      return { ok: false, error: "A custom pitch needs a description of who is writing and why." };
    }
    if (!pitchFacts.length) {
      return {
        ok: false,
        error:
          "A custom pitch needs at least one fact. Drafts may only state what you list here, so an empty list means every draft gets rejected.",
      };
    }
  }

  // Scanning is the audit pitch's evidence step; default it off for a custom
  // pitch rather than scanning people we're emailing about something else.
  const scanProspects = input.scanProspects ?? pitchMode === "audit";
  if (pitchMode === "audit" && !scanProspects) {
    return {
      ok: false,
      error:
        "The audit pitch is built from scan findings, so it can't run with scanning turned off. Switch to a custom pitch instead.",
    };
  }

  if (input.autoSend) {
    const postal = await loadAddressSettings({ projectId: input.projectId, ownerId: auth.userId });
    if (!postal.address) {
      return {
        ok: false,
        error:
          "No sender postal address is set. CAN-SPAM requires one in commercial email, so live sending stays off until you add it above.",
      };
    }
  }

  const { error } = await serviceClient()
    .from("outreach_campaigns")
    .upsert(
      {
        project_id: input.projectId,
        owner_id: auth.userId,
        name: input.name.trim(),
        channel: "email",
        active: input.active,
        queries,
        seed_urls: seedUrls,
        max_score: input.maxScore,
        daily_send_limit: input.dailySendLimit,
        auto_send: input.autoSend,
        angle: input.angle?.trim() || null,
        sender_name: input.senderName?.trim() || null,
        reply_to: input.replyTo?.trim() || null,
        pitch_mode: pitchMode,
        pitch_intro: input.pitchIntro?.trim() || null,
        pitch_ask: input.pitchAsk?.trim() || null,
        pitch_facts: pitchFacts,
        scan_prospects: scanProspects,
      },
      { onConflict: "project_id,name" },
    );
  if (error) return { ok: false, error: error.message };

  revalidatePath(leadsPath(input.projectId));
  return {
    ok: true,
    note: input.autoSend
      ? `"${input.name}" saved — auto-send is ON, so the cron tick will email real people.`
      : `"${input.name}" saved. It will find, scan and draft; sending stays off until you turn it on.`,
  };
}

export async function runCampaignAction(input: {
  projectId: string;
  name: string;
}): Promise<Ok<{ note: string }> | Err> {
  const auth = await requireLeadAccess(input.projectId);
  if (!auth.ok) return auth;
  const { data } = await serviceClient()
    .from("outreach_campaigns")
    .select(CAMPAIGN_COLUMNS)
    .eq("project_id", input.projectId)
    .eq("name", input.name)
    .maybeSingle();
  if (!data) return { ok: false, error: "Campaign not found." };

  const result = await runEmailCampaignTick(data as CampaignRow);
  revalidatePath(leadsPath(input.projectId));
  return { ok: true, note: `${result.campaign}: ${summarize(result)}` };
}

export async function toggleCampaignAction(input: {
  projectId: string;
  name: string;
  field: "active" | "auto_send";
  value: boolean;
}): Promise<Ok<{ note: string }> | Err> {
  const auth = await requireLeadAccess(input.projectId);
  if (!auth.ok) return auth;
  if (input.field === "auto_send" && input.value) {
    const postal = await loadAddressSettings({ projectId: input.projectId, ownerId: auth.userId });
    if (!postal.address) {
      return { ok: false, error: "No sender postal address is set — live sending is blocked until you add one." };
    }
  }
  const { error } = await serviceClient()
    .from("outreach_campaigns")
    .update({ [input.field]: input.value })
    .eq("project_id", input.projectId)
    .eq("name", input.name);
  if (error) return { ok: false, error: error.message };
  revalidatePath(leadsPath(input.projectId));
  return {
    ok: true,
    note:
      input.field === "active"
        ? `"${input.name}" ${input.value ? "resumed" : "paused"}.`
        : `"${input.name}" auto-send ${input.value ? "ON — it will email real people" : "off"}.`,
  };
}
