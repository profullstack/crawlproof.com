// The page-wide Humans / Bots / All toggle on /projects/:id/stats.
//
// One value, carried in the URL as ?who=, drives every number on the page:
// the headline tiles, the Traffic pulse series, each breakdown card and the
// live panel. It maps onto the `p_kind` argument every tracker RPC accepts
// (see supabase/migrations/20260905190000_tracker_kind_split.sql) and onto
// the bucket filter the raw live-events route applies. The mapping lives
// here so the server page, the API route and the client hook cannot drift
// on what "humans" means.
//
// Default is humans: the page leads with people (lib/tracker/humans.ts).

import {
  AI_REFERRALS_DEFINITION,
  ALL_EVENTS_DEFINITION,
  BOTS_DEFINITION,
  BOTS_LABEL,
  HUMANS_DEFINITION,
  HUMANS_LABEL,
  PAGEVIEWS_DEFINITION,
  PAGEVIEWS_LABEL,
  VISITORS_DEFINITION,
  VISITORS_LABEL,
  type TrackerKind,
} from "@/lib/tracker/humans";

export type Who = "humans" | "bots" | "all";

export const WHO_VALUES: Who[] = ["humans", "bots", "all"];

export const DEFAULT_WHO: Who = "humans";

export const WHO_PARAM = "who";

/** Strict parse: null for anything that is not exactly one of the three. */
export function parseWho(value: string | null | undefined): Who | null {
  return (WHO_VALUES as string[]).includes(value ?? "") ? (value as Who) : null;
}

/** Lenient parse for the page: junk falls back to the default. */
export function whoOrDefault(value: string | null | undefined): Who {
  return parseWho(value) ?? DEFAULT_WHO;
}

/** The RPC argument: null means "no filter", which is what All asks for. */
export function whoToKind(who: Who): TrackerKind | null {
  switch (who) {
    case "humans":
      return "human";
    case "bots":
      return "bot";
    default:
      return null;
  }
}

export type WhoOption = {
  key: Who;
  label: string;
  /** Tooltip; the same definition every labelled figure carries. */
  description: string;
};

export const WHO_OPTIONS: WhoOption[] = [
  { key: "humans", label: "Humans", description: HUMANS_DEFINITION },
  { key: "bots", label: "Bots", description: BOTS_DEFINITION },
  { key: "all", label: "All", description: ALL_EVENTS_DEFINITION },
];

// The bucket-less rollups (pages, referrers, actions, exit pages, countries,
// cities, devices) only record the human / bot side of a hit from the day
// the kind-split migration was applied. Rows before it are `unknown` and
// answer only under All, so any filtered view has to say where its history
// starts.
export const KIND_SPLIT_SINCE = "2026-09-05";
export const KIND_SPLIT_SINCE_LABEL = "5 Sep 2026";
export const KIND_SPLIT_CAPTION = `Split recorded from ${KIND_SPLIT_SINCE_LABEL}; earlier traffic appears under All.`;

/** The caption under the toggle, or null when nothing is filtered out. */
export function whoCaption(who: Who): string | null {
  return who === "all" ? null : KIND_SPLIT_CAPTION;
}

export type HeadlineTotals = {
  /**
   * Distinct visitors in the window from the visitor rollup, on the side
   * `who` asks for. null when the rollup could not be read: the tile is then
   * left out rather than shown as 0, because 0 reads as a dead site.
   */
  visitors?: number | null;
  /** Page views those visitors produced; drawn only beside `visitors`. */
  pageviews?: number | null;
  /** Events, not people: every beacon on the human side. */
  humans: number;
  ai: number;
  bots: number;
};

export type HeadlineTile = {
  key: "visitors" | "pageviews" | "humans" | "ai" | "bots";
  label: string;
  value: number;
  tone: "accent" | "pass" | "warn" | "muted";
  hint: string;
};

/**
 * Which headline tiles the page shows for a given toggle. Humans leads with
 * people (distinct visitors, then their page views) and shows the event
 * count under its real name after them; Bots shows its own side; All keeps
 * both sides. The figures come from the series and the visitor rollup the
 * page fetched at that same `who`, so a filtered view never mixes in the
 * other side's count.
 */
export function headlineTiles(who: Who, t: HeadlineTotals): HeadlineTile[] {
  const people: HeadlineTile[] =
    t.visitors === null || t.visitors === undefined
      ? []
      : [
          {
            key: "visitors",
            label: who === "bots" ? "Bot visitors" : VISITORS_LABEL,
            value: t.visitors,
            tone: who === "bots" ? "warn" : "accent",
            hint:
              who === "bots"
                ? "Distinct visitor ids on the bot side: crawlers that ran the script, and scripted browsers caught by volume."
                : VISITORS_DEFINITION,
          },
          {
            key: "pageviews",
            label: PAGEVIEWS_LABEL,
            value: t.pageviews ?? 0,
            tone: who === "bots" ? "warn" : "accent",
            hint: PAGEVIEWS_DEFINITION,
          },
        ];
  const humans: HeadlineTile = {
    key: "humans",
    label: HUMANS_LABEL,
    value: t.humans,
    // Leads only when the rollup has nothing to say; otherwise it is the
    // number people used to mistake for readers, kept but demoted.
    tone: people.length ? "muted" : "accent",
    hint: HUMANS_DEFINITION,
  };
  const ai: HeadlineTile = {
    key: "ai",
    label: "AI referrals",
    value: t.ai,
    tone: "pass",
    hint: AI_REFERRALS_DEFINITION,
  };
  const bots: HeadlineTile = {
    key: "bots",
    label: BOTS_LABEL,
    value: t.bots,
    tone: "warn",
    hint: BOTS_DEFINITION,
  };
  switch (who) {
    case "humans":
      return [...people, humans, ai];
    case "bots":
      return [...people, bots];
    default:
      return [...people, humans, ai, bots];
  }
}

export type PulseLayer = {
  dataKey: "humans" | "bots" | "ai" | "interactions";
  name: string;
  /** Stacked layers share a stack id; overlays have none. */
  stackId?: string;
  color: string;
  fillOpacity: number;
  dashed?: boolean;
};

const HUMANS_LAYER: PulseLayer = {
  dataKey: "humans",
  name: "Human events",
  stackId: "1",
  color: "var(--color-accent)",
  fillOpacity: 0.28,
};
const BOTS_LAYER: PulseLayer = {
  dataKey: "bots",
  name: "Bot crawls",
  stackId: "1",
  color: "var(--color-warn)",
  fillOpacity: 0.14,
};
const AI_LAYER: PulseLayer = {
  dataKey: "ai",
  name: "AI referrals (within humans)",
  color: "var(--color-pass)",
  fillOpacity: 0.16,
};
const INTERACTIONS_LAYER: PulseLayer = {
  dataKey: "interactions",
  name: "Interactions",
  color: "#60a5fa",
  fillOpacity: 0,
  dashed: true,
};

/**
 * Which series the Traffic pulse draws. Humans: the human band with AI
 * referrals inside it; Bots: the bot band alone; All: both stacked. The
 * interactions overlay (clicks and forms) is on every view, filtered to the
 * same side by the RPC.
 */
export function pulseLayers(who: Who): PulseLayer[] {
  switch (who) {
    case "humans":
      return [HUMANS_LAYER, AI_LAYER, INTERACTIONS_LAYER];
    case "bots":
      return [BOTS_LAYER, INTERACTIONS_LAYER];
    default:
      return [HUMANS_LAYER, BOTS_LAYER, AI_LAYER, INTERACTIONS_LAYER];
  }
}

/** The figure the Traffic pulse frame leads with, and the noun for it. */
export function pulseHeadline(
  who: Who,
  totals: { humans: number; bots: number },
): { total: number; unit: [string, string]; hint: string } {
  if (who === "bots") {
    return {
      total: totals.bots,
      unit: ["bot crawl", "bot crawls"],
      hint: BOTS_DEFINITION,
    };
  }
  return {
    total: totals.humans,
    unit: ["human event", "human events"],
    hint: HUMANS_DEFINITION,
  };
}
