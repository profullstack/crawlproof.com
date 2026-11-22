// Buyer Intent: the pure parts. No I/O here so it is all unit-testable.

import { createHmac } from "node:crypto";
import { LEAD_RUN_CREDITS } from "@/lib/credits";
import { INTENT_SOURCES } from "@/lib/outreach/intentSources";
import { NATIVE_SOURCES } from "./native";

export type LeadTier = "hot" | "engage" | "monitor";
export type Cadence = "daily" | "4h" | "hourly";

export const TIER_LABELS: Record<LeadTier, string> = {
  hot: "Hot lead",
  engage: "Worth engaging",
  monitor: "Monitor",
};

export const TIER_HINTS: Record<LeadTier, string> = {
  hot: "High purchase intent: reply today.",
  engage: "Moderate intent: a good outreach target.",
  monitor: "Low intent: worth keeping an eye on.",
};

/** One sweep costs what a lead-generation run costs. */
export const INTENT_SWEEP_CREDITS = LEAD_RUN_CREDITS;
/** A drafted reply costs one credit, like an outreach send. */
export const REPLY_DRAFT_CREDITS = 1;

export const CADENCE_MS: Record<Cadence, number> = {
  daily: 24 * 3_600_000,
  "4h": 4 * 3_600_000,
  hourly: 3_600_000,
};
export const CADENCE_LABELS: Record<Cadence, string> = {
  daily: "Once a day",
  "4h": "Every 4 hours",
  hourly: "Every hour",
};

/** SERP calls one run may spend: keywords first, then competitors. */
export const KEYWORD_CALL_BUDGET = 8;
export const COMPETITOR_CALL_BUDGET = 4;
export const MAX_WATCHES_PER_OWNER = 10;

/** Ids a watch may select: the SERP groups plus GitHub, which only the native path searches. */
export const SOURCE_IDS = [...INTENT_SOURCES.map((s) => s.id), "github"];
export function sourceLabel(id: string): string {
  return INTENT_SOURCES.find((s) => s.id === id)?.label ?? NATIVE_SOURCES.find((s) => s.id === id)?.label ?? id;
}

export function isCadence(v: unknown): v is Cadence {
  return v === "daily" || v === "4h" || v === "hourly";
}

/** Map the 0–100 intent score onto the three buckets people act on. */
export function leadTier(score: number): LeadTier {
  if (score >= 70) return "hot";
  if (score >= 40) return "engage";
  return "monitor";
}

/** Which saved competitor, if any, the post names. Word-boundary, any case. */
export function matchCompetitor(text: string, competitors: string[]): string | null {
  const hay = text.toLowerCase();
  for (const c of competitors) {
    const name = c.trim().toLowerCase();
    if (!name) continue;
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`).test(hay)) return c.trim();
  }
  return null;
}

/** Split a comma/newline list into trimmed, de-duplicated, bounded terms. */
export function parseTerms(raw: unknown, max = 20): string[] {
  const list = Array.isArray(raw) ? raw.map(String) : String(raw ?? "").split(/[,\n]/);
  const out: string[] = [];
  for (const t of list) {
    const v = t.trim().slice(0, 80);
    if (v && !out.some((o) => o.toLowerCase() === v.toLowerCase())) out.push(v);
    if (out.length >= max) break;
  }
  return out;
}

export function nextRunAt(cadence: Cadence, from = new Date()): Date {
  return new Date(from.getTime() + CADENCE_MS[cadence]);
}

export type LeadRow = {
  id?: string;
  source: string;
  url: string;
  title: string;
  snippet: string;
  posted_at: string | null;
  score: number;
  tier: LeadTier;
  intent_kind: string | null;
  competitor: string | null;
  status: string;
  created_at?: string;
};

function csvCell(v: unknown): string {
  let s = v == null ? "" : String(v);
  // Defuse spreadsheet formula injection from post text.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function leadsToCsv(rows: LeadRow[]): string {
  const head = ["score", "tier", "source", "title", "url", "snippet", "intent", "competitor", "posted_at", "status", "found_at"];
  const lines = rows.map((r) =>
    [r.score, TIER_LABELS[r.tier], sourceLabel(r.source), r.title, r.url, r.snippet, r.intent_kind, r.competitor, r.posted_at, r.status, r.created_at]
      .map(csvCell)
      .join(","),
  );
  return [head.join(","), ...lines].join("\n") + "\n";
}

/** Header value for signed webhook deliveries: sha256=<hex HMAC of the raw body>. */
export function signBody(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}
