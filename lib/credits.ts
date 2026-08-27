// Credit pack catalog.
// 1 credit ≈ $0.05 (a "nickel credit") at full rack rate. Larger packs come
// with a sliding-scale discount off that rate. Credits are the universal,
// integer-only spend unit: cheap actions (outreach) cost 1 credit, expensive
// AI actions (a scan, an article, a guest post, a GitHub auto-fix) cost
// SCAN_CREDITS each — which keeps an AI action at ~$1 rack like before.

// Rack price of one credit, in cents. Drives discount math + UI strikethroughs.
export const CREDIT_RACK_CENTS = 5;

// Credits charged for one expensive AI action (scan / article / guest post /
// auto-fix). 20 × $0.05 = $1.00 rack, unchanged from the old 1-credit-=-$1 era.
export const SCAN_CREDITS = 20;

// Credits charged for one outreach send (email / SMS recipient / social post).
export const OUTREACH_CREDITS = 1;

/**
 * Credits charged to publish one job posting on the careers widget.
 *
 * Charged once per posting, the first time it goes open — not per month and
 * not per edit. Closing a role and re-opening it is free, so a seasonal
 * listing isn't billed twice for the same hire.
 *
 * Serving costs us almost nothing (the jobs feed is a cached read), so this is
 * priced as a listing fee rather than off cost: 5c a posting at rack, against
 * $200-and-up to list the same role on a real job board.
 */
export const JOB_POSTING_CREDITS = 1;

/**
 * One billable lead-generation tick: discovery, contact lookup and drafting.
 *
 * Priced off measured cost rather than a guess. At the per-tick caps the run
 * spends roughly 3.8c on ValueSERP (five discovery queries plus the contact
 * fallback), 0.9c on drafting, and a fraction of a cent on rendering — about
 * 4.9c at the ceiling and closer to 2c in ordinary use. Search dominates;
 * the AI is under a fifth of it, so pricing off model cost alone would
 * undercharge by roughly five times.
 *
 * Three credits is 15c at rack and 7.5c on the deepest pack, which keeps a
 * margin at every tier. Two would have been exactly break-even for anyone on
 * the 100-scan pack.
 *
 * Charged only when a tick actually spends: the cron fires every fifteen
 * minutes, so billing an idle campaign per tick would cost a user 288 credits
 * a day for no work.
 */
export const LEAD_RUN_CREDITS = 3;

/** Leads covered by one charge on the manual finder. */
export const LEADS_PER_CHARGE = 100;

/**
 * Paid search lookups a single charge buys.
 *
 * Matches the per-tick ceiling the price above was measured against, so a
 * manual run and an automated one cost the same per unit of the thing that
 * actually spends money. Without it a thousand-lead run would buy a hundred
 * lookups for the price of ten.
 */
export const CONTACT_SEARCHES_PER_CHARGE = 10;

/**
 * What a manual find-leads run costs, and the search budget it buys.
 *
 * Priced per hundred leads asked for rather than per lead: the request size is
 * what the user chooses, and it is the only figure available before the run
 * starts. Rounded up, so asking for one lead is not free.
 *
 * Pure, and kept here rather than beside the deduction, so the form can show
 * the price without pulling a database client into the browser bundle.
 */
export function manualRunPrice(limit: number): {
  credits: number;
  contactSearches: number;
} {
  const blocks = Math.max(1, Math.ceil(limit / LEADS_PER_CHARGE));
  return {
    credits: blocks * LEAD_RUN_CREDITS,
    contactSearches: blocks * CONTACT_SEARCHES_PER_CHARGE,
  };
}

export type CreditPack = {
  id: string;
  label: string;
  credits: number;
  amountCents: number; // What we actually charge.
  popular?: boolean;
};

// credits = scan-equivalents × SCAN_CREDITS; amountCents unchanged from the
// $1/scan era, so the same dollars now buy 20× the (smaller) credits.
export const CREDIT_PACKS: CreditPack[] = [
  { id: "pack-1", label: "Starter", credits: 20, amountCents: 100 }, // $1.00/scan — full rack rate
  { id: "pack-10", label: "10 scans", credits: 200, amountCents: 900 }, // $0.90/scan — 10% off
  { id: "pack-50", label: "50 scans", credits: 1000, amountCents: 3500, popular: true }, // $0.70/scan — 30% off
  // Deepest bundle is anchored at ~2× the worst-case per-scan cost
  // (Claude Sonnet 4.6 ~$0.26 → cap of $0.52). Rounded to $0.50/scan
  // so Claude lands at ~92% markup and the floor stays at or below
  // the 100% markup ceiling.
  { id: "pack-100", label: "100 scans", credits: 2000, amountCents: 5000 }, // $0.50/scan — 50% off
];

export function findPack(id: string): CreditPack | undefined {
  return CREDIT_PACKS.find((p) => p.id === id);
}

export function dollars(cents: number): string {
  return `$${(cents / 100).toLocaleString(undefined, {
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
  })}`;
}

// Effective price of one scan (= SCAN_CREDITS credits) under this pack, in cents.
export function perScanCents(pack: CreditPack): number {
  return Math.round((pack.amountCents * SCAN_CREDITS) / pack.credits);
}

// Effective price of a single credit under this pack, in cents.
export function perCreditCents(pack: CreditPack): number {
  return Math.round(pack.amountCents / pack.credits);
}

// ----- Engines (free utilities + partner scanners + LLM providers) ----------
export type Engine =
  | "rule"
  | "spec"
  | "dns"
  | "links"
  | "slop"
  | "repo"
  | "vu1nz"
  | "claude"
  | "openai"
  | "qwen"
  | "kimi"
  | "gemini"
  | "deepseek"
  | "zai"
  | "perplexity"
  | "fugu";

export const DEFAULT_PROJECT_ENGINES: Engine[] = ["rule", "dns"];

export type EngineMeta = {
  label: string;
  cost: number;
  blurb: string;
  popular?: boolean;
  available: boolean; // false → disabled in selectors, action rejects
};

export const ENGINES: Record<Engine, EngineMeta> = {
  rule: {
    label: "Rule-based",
    cost: 0,
    available: true,
    blurb:
      "Deterministic engine — fetches your site, parses HTML / JSON-LD / robots, generates the structured report. Free.",
  },
  spec: {
    label: "specification.website",
    cost: 0,
    available: true,
    blurb:
      "Runs your URL against the specification.website checklist — 114 checks across Foundations, SEO, Security, Accessibility, Agent Readiness, Performance, Privacy, Resilience, and Internationalisation. Free.",
  },
  dns: {
    label: "DNS Analyzer",
    cost: 0,
    available: true,
    blurb:
      "Resolves your domain's full DNS footprint — A/AAAA, MX, NS, SOA, CAA plus email auth (SPF, DKIM, DMARC, MTA-STS, BIMI) — then has AI flag missing, weak, or harmful records and hand you paste-ready fixes. Free.",
  },
  links: {
    label: "Link checker",
    cost: 0,
    available: true,
    blurb:
      "Recursively crawls your root domain (powered by linkinator) and reports every broken link — 404s, dead redirects, unreachable hosts — with the page each was found on. Free.",
  },
  slop: {
    label: "Slop Score",
    cost: 0,
    available: true,
    popular: true,
    blurb:
      "Sweeps up to 50 pages and scores how careless your site looks — placeholder copy, near-duplicate pages, leaked template variables, missing first-party evidence, stale dates, design drift — with a per-page fix list. Reports observable defects, not \"was this AI-written\". Free.",
  },
  repo: {
    label: "Repo Health",
    cost: 0,
    available: true,
    blurb:
      "Scores the GitHub project behind your site: a 0–100 health score (commit recency, rhythm, issue and PR resolution) plus an undervalued score that measures the building against the attention it has already received. Ten behavioral signals — solo builder, hidden gem, fork magnet, release machine — with the fixes that move each one. Free.",
  },
  vu1nz: {
    label: "Vu1nz web scanner",
    cost: 0,
    available: true,
    blurb:
      "Partner website scanner from Vu1nz — runs the web check API for security and vulnerability signals. Free.",
  },
  claude: {
    label: "Claude Sonnet 4.6",
    cost: SCAN_CREDITS,
    available: true,
    blurb:
      "Anthropic's fast tier with web_fetch + web_search. Snappy AEO audit framed the way ClaudeBot would discover your site.",
  },
  openai: {
    label: "OpenAI GPT-5 Mini",
    cost: SCAN_CREDITS,
    available: true,
    blurb:
      "OpenAI's fast tier with live web search. Snappy second opinion framed the way an OpenAI-tier answer engine would.",
  },
  qwen: {
    label: "Qwen Max",
    cost: SCAN_CREDITS,
    available: true,
    blurb:
      "Alibaba's flagship model via DashScope. Cost-efficient second opinion on Chinese / cross-language sites.",
  },
  kimi: {
    label: "Kimi v2.6",
    cost: SCAN_CREDITS,
    available: true,
    blurb:
      "Moonshot AI's flagship via OpenAI-compatible API. Strong long-context reasoning over your full homepage.",
  },
  gemini: {
    label: "Gemini 2.5 Pro",
    cost: SCAN_CREDITS,
    available: true,
    blurb:
      "Google's flagship with live Search grounding. Frames your site the way Google AI Overviews would.",
  },
  deepseek: {
    label: "DeepSeek V4",
    cost: SCAN_CREDITS,
    available: true,
    blurb:
      "Cost-efficient open-weight model. Strong reasoning, OpenAI-compatible API — quick, lightweight second opinion.",
  },
  zai: {
    label: "Z.AI GLM-5.2",
    cost: SCAN_CREDITS,
    available: true,
    blurb:
      "Zhipu AI's flagship GLM-5.2 via Z.AI's OpenAI-compatible API. Strong bilingual reasoning — a frontier second opinion on your site.",
  },
  perplexity: {
    label: "Perplexity Sonar Pro",
    cost: SCAN_CREDITS,
    available: true,
    blurb:
      "Web-grounded with live citations. Frames your site the way Perplexity's answer engine would surface it to users.",
  },
  fugu: {
    label: "Sakana Fugu",
    cost: SCAN_CREDITS,
    available: true,
    blurb:
      "Sakana AI's orchestration model — routes each request across a swappable pool of frontier LLMs for a frontier-level, vendor-neutral second opinion.",
  },
};

export function engineCost(engine: Engine): number {
  return ENGINES[engine].cost;
}

export function engineAvailable(engine: Engine): boolean {
  return ENGINES[engine].available;
}

export function selectionCost(engines: Engine[]): number {
  return engines.reduce((sum, e) => sum + (ENGINES[e]?.cost ?? 0), 0);
}

export function dedupeEngines(engines: Engine[]): Engine[] {
  const seen = new Set<Engine>();
  const out: Engine[] = [];
  for (const e of engines) {
    if (ENGINES[e] && !seen.has(e)) {
      seen.add(e);
      out.push(e);
    }
  }
  return out;
}

export function discountPct(pack: CreditPack): number {
  const rack = pack.credits * CREDIT_RACK_CENTS;
  if (pack.amountCents >= rack) return 0;
  return Math.round(((rack - pack.amountCents) / rack) * 100);
}
