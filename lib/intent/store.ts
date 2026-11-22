// Buyer Intent data access, shared by the REST API, the dashboard actions and
// the MCP tools. Everything is scoped to an owner id the caller has already
// authenticated; the service client is used because the tables are
// read-only to the browser (RLS select-own, no client writes).

import { randomBytes } from "node:crypto";
import { serviceClient } from "@/lib/supabase/service";
import { consumeCredit, refundCredit } from "@/lib/rateLimit";
import { draftReply } from "./reply";
import { runIntentWatch, type IntentWatch, type RunResult } from "./run";
import {
  MAX_WATCHES_PER_OWNER,
  REPLY_DRAFT_CREDITS,
  SOURCE_IDS,
  isCadence,
  parseTerms,
  sourceLabel,
  type LeadRow,
  type LeadTier,
} from "./tiers";

export class IntentError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

const WATCH_COLUMNS =
  "id, owner_id, name, sells, keywords, competitors, negative_keywords, sources, cadence, min_score, slack_webhook_url, discord_webhook_url, webhook_url, webhook_secret, email_digest, active, last_run_at, next_run_at, last_error, created_at";
const LEAD_COLUMNS =
  "id, watch_id, source, url, title, snippet, posted_at, score, tier, intent_kind, competitor, reasons, decision_maker, reply_draft, status, created_at";

export type WatchInput = Partial<{
  name: string;
  sells: string;
  keywords: string[] | string;
  competitors: string[] | string;
  negative_keywords: string[] | string;
  sources: string[] | string;
  cadence: string;
  min_score: number | string;
  slack_webhook_url: string;
  discord_webhook_url: string;
  webhook_url: string;
  email_digest: boolean | string;
  active: boolean | string;
}>;

function optUrl(v: unknown, label: string, prefixes?: string[]): string | null {
  const s = typeof v === "string" ? v.trim() : "";
  if (!s) return null;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new IntentError(`${label} is not a valid URL.`);
  }
  if (u.protocol !== "https:") throw new IntentError(`${label} must be https.`);
  if (prefixes && !prefixes.some((p) => s.startsWith(p))) {
    throw new IntentError(`${label} must start with ${prefixes[0]}`);
  }
  return s.slice(0, 500);
}

function bool(v: unknown, dflt: boolean): boolean {
  if (v === undefined || v === null || v === "") return dflt;
  if (typeof v === "boolean") return v;
  return ["1", "true", "on", "yes"].includes(String(v).toLowerCase());
}

/** Validate and normalise a create/update body. `partial` keeps absent fields absent. */
export function normaliseWatch(input: WatchInput, partial = false): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const has = (k: keyof WatchInput) => !partial || input[k] !== undefined;
  if (has("name")) {
    const name = String(input.name ?? "").trim().slice(0, 120);
    if (!name) throw new IntentError("Give the watch a name (your product or brand).");
    out.name = name;
  }
  if (has("sells")) out.sells = String(input.sells ?? "").trim().slice(0, 2000) || null;
  if (has("keywords")) out.keywords = parseTerms(input.keywords);
  if (has("competitors")) out.competitors = parseTerms(input.competitors, 10);
  if (has("negative_keywords")) out.negative_keywords = parseTerms(input.negative_keywords);
  if (has("sources")) out.sources = parseTerms(input.sources).filter((s) => SOURCE_IDS.includes(s));
  if (has("cadence")) {
    const c = input.cadence ?? "daily";
    if (!isCadence(c)) throw new IntentError("Cadence must be daily, 4h or hourly.");
    out.cadence = c;
  }
  if (has("min_score")) {
    const n = Number(input.min_score ?? 25);
    out.min_score = Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : 25;
  }
  if (has("slack_webhook_url")) out.slack_webhook_url = optUrl(input.slack_webhook_url, "Slack webhook", ["https://hooks.slack.com/"]);
  if (has("discord_webhook_url"))
    out.discord_webhook_url = optUrl(input.discord_webhook_url, "Discord webhook", [
      "https://discord.com/api/webhooks/",
      "https://discordapp.com/api/webhooks/",
    ]);
  if (has("webhook_url")) out.webhook_url = optUrl(input.webhook_url, "Webhook URL");
  if (has("email_digest")) out.email_digest = bool(input.email_digest, true);
  if (has("active")) out.active = bool(input.active, true);
  if (!partial) {
    const kw = out.keywords as string[];
    const comp = out.competitors as string[];
    if (!kw.length && !comp.length) throw new IntentError("Add at least one keyword or competitor to track.");
  }
  return out;
}

export async function listWatches(ownerId: string) {
  const { data, error } = await serviceClient()
    .from("intent_watches")
    .select(WATCH_COLUMNS)
    .eq("owner_id", ownerId)
    .order("created_at", { ascending: true });
  if (error) throw new IntentError(error.message, 500);
  return (data ?? []) as Array<IntentWatch & { last_run_at: string | null; next_run_at: string; last_error: string | null; created_at: string }>;
}

export async function getWatch(ownerId: string, id: string) {
  const { data } = await serviceClient().from("intent_watches").select(WATCH_COLUMNS).eq("id", id).eq("owner_id", ownerId).maybeSingle();
  if (!data) throw new IntentError("Watch not found.", 404);
  return data as IntentWatch & { last_run_at: string | null; last_error: string | null };
}

export async function createWatch(ownerId: string, input: WatchInput) {
  const svc = serviceClient();
  const { count } = await svc.from("intent_watches").select("id", { count: "exact", head: true }).eq("owner_id", ownerId);
  if ((count ?? 0) >= MAX_WATCHES_PER_OWNER) throw new IntentError(`Up to ${MAX_WATCHES_PER_OWNER} watches per account.`);
  const row = normaliseWatch(input);
  if (row.webhook_url) row.webhook_secret = `whsec_${randomBytes(24).toString("hex")}`;
  const { data, error } = await svc
    .from("intent_watches")
    .insert({ ...row, owner_id: ownerId, next_run_at: new Date().toISOString() })
    .select(WATCH_COLUMNS)
    .single();
  if (error || !data) throw new IntentError(error?.message ?? "Could not create the watch.", 500);
  return data as IntentWatch;
}

export async function updateWatch(ownerId: string, id: string, input: WatchInput) {
  const current = await getWatch(ownerId, id);
  const row = normaliseWatch(input, true);
  if (row.webhook_url && !current.webhook_secret) row.webhook_secret = `whsec_${randomBytes(24).toString("hex")}`;
  const { data, error } = await serviceClient()
    .from("intent_watches")
    .update(row)
    .eq("id", id)
    .eq("owner_id", ownerId)
    .select(WATCH_COLUMNS)
    .single();
  if (error || !data) throw new IntentError(error?.message ?? "Could not update the watch.", 500);
  return data as IntentWatch;
}

export async function deleteWatch(ownerId: string, id: string) {
  await getWatch(ownerId, id);
  const { error } = await serviceClient().from("intent_watches").delete().eq("id", id).eq("owner_id", ownerId);
  if (error) throw new IntentError(error.message, 500);
}

export async function runWatchNow(ownerId: string, id: string): Promise<RunResult> {
  const w = await getWatch(ownerId, id);
  return runIntentWatch(serviceClient(), w);
}

export type LeadFilter = {
  watchId?: string | null;
  tier?: LeadTier | null;
  status?: string | null;
  source?: string | null;
  limit?: number;
};

export async function listLeads(ownerId: string, f: LeadFilter = {}) {
  let q = serviceClient().from("intent_leads").select(LEAD_COLUMNS).eq("owner_id", ownerId);
  if (f.watchId) q = q.eq("watch_id", f.watchId);
  if (f.tier) q = q.eq("tier", f.tier);
  if (f.status) q = q.eq("status", f.status);
  else q = q.neq("status", "dismissed");
  if (f.source) q = q.eq("source", f.source);
  const { data, error } = await q
    .order("created_at", { ascending: false })
    .order("score", { ascending: false })
    .limit(Math.max(1, Math.min(1000, f.limit ?? 200)));
  if (error) throw new IntentError(error.message, 500);
  return (data ?? []) as Array<LeadRow & { id: string; watch_id: string; reasons: string[]; decision_maker: boolean; reply_draft: string | null }>;
}

export async function setLeadStatus(ownerId: string, id: string, status: string) {
  if (!["new", "replied", "dismissed"].includes(status)) throw new IntentError("Status must be new, replied or dismissed.");
  const { data, error } = await serviceClient()
    .from("intent_leads")
    .update({ status })
    .eq("id", id)
    .eq("owner_id", ownerId)
    .select("id, status")
    .maybeSingle();
  if (error) throw new IntentError(error.message, 500);
  if (!data) throw new IntentError("Lead not found.", 404);
  return data;
}

/** Draft (or return the stored) reply for one lead. Charges once per lead. */
export async function draftLeadReply(ownerId: string, id: string, regenerate = false): Promise<string> {
  const svc = serviceClient();
  const { data: lead } = await svc
    .from("intent_leads")
    .select("id, watch_id, source, title, snippet, reply_draft")
    .eq("id", id)
    .eq("owner_id", ownerId)
    .maybeSingle();
  if (!lead) throw new IntentError("Lead not found.", 404);
  if (lead.reply_draft && !regenerate) return lead.reply_draft as string;
  const watch = await getWatch(ownerId, lead.watch_id as string);

  const paid = await consumeCredit(ownerId, REPLY_DRAFT_CREDITS);
  if (!paid.ok) throw new IntentError(`Out of credits: a reply draft costs ${REPLY_DRAFT_CREDITS}.`, 402);
  let reply: string;
  try {
    reply = await draftReply({
      title: lead.title as string,
      snippet: lead.snippet as string,
      source: sourceLabel(lead.source as string),
      sells: watch.sells,
      productName: watch.name,
    });
  } catch (err) {
    await refundCredit(ownerId, REPLY_DRAFT_CREDITS).catch(() => null);
    throw new IntentError(`Could not draft a reply: ${err instanceof Error ? err.message : String(err)}`, 502);
  }
  await svc.from("intent_leads").update({ reply_draft: reply }).eq("id", id);
  return reply;
}

/** The public shape of a watch: the signing secret is shown, it is the owner's. */
export function publicWatch(w: IntentWatch & Record<string, unknown>) {
  const { owner_id: _o, ...rest } = w;
  return rest;
}
