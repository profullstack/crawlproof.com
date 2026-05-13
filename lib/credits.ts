// Credit pack catalog. 1 credit = 1 scan.
// Larger packs come with a sliding-scale discount off the $1/credit rack rate.

export type CreditPack = {
  id: string;
  label: string;
  credits: number;
  amountCents: number; // What we actually charge.
  popular?: boolean;
};

export const CREDIT_PACKS: CreditPack[] = [
  { id: "pack-1", label: "Starter", credits: 1, amountCents: 100 }, // $1.00/scan
  { id: "pack-10", label: "10 scans", credits: 10, amountCents: 900 }, // $0.90/scan — 10% off
  { id: "pack-50", label: "50 scans", credits: 50, amountCents: 3750, popular: true }, // $0.75/scan — 25% off
  { id: "pack-100", label: "100 scans", credits: 100, amountCents: 7000 }, // $0.70/scan — 30% off
];

export function findPack(id: string): CreditPack | undefined {
  return CREDIT_PACKS.find((p) => p.id === id);
}

export function dollars(cents: number): string {
  return `$${(cents / 100).toLocaleString(undefined, {
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
  })}`;
}

export function perScanCents(pack: CreditPack): number {
  return Math.round(pack.amountCents / pack.credits);
}

// ----- Engines (rule + 6 LLM providers) -----------------------------------
export type Engine =
  | "rule"
  | "claude"
  | "openai"
  | "qwen"
  | "kimi"
  | "gemini"
  | "deepseek"
  | "perplexity";

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
  claude: {
    label: "Claude Opus 4.7",
    cost: 1,
    available: true,
    popular: true,
    blurb:
      "Anthropic's most-capable model audits your site with adaptive thinking + web tools.",
  },
  openai: {
    label: "OpenAI GPT-5 Mini",
    cost: 1,
    available: true,
    blurb:
      "OpenAI's fast tier with live web search. Snappy second opinion framed the way an OpenAI-tier answer engine would.",
  },
  qwen: {
    label: "Qwen Max",
    cost: 1,
    available: true,
    blurb:
      "Alibaba's flagship model via DashScope. Cost-efficient second opinion on Chinese / cross-language sites.",
  },
  kimi: {
    label: "Kimi K2",
    cost: 1,
    available: true,
    blurb:
      "Moonshot AI's flagship via OpenAI-compatible API. Strong long-context reasoning over your full homepage.",
  },
  gemini: {
    label: "Gemini 2.5 Pro",
    cost: 1,
    available: true,
    blurb:
      "Google's flagship with live Search grounding. Frames your site the way Google AI Overviews would.",
  },
  deepseek: {
    label: "DeepSeek V3",
    cost: 1,
    available: true,
    blurb:
      "Cost-efficient open-weight model. Strong reasoning, OpenAI-compatible API — quick, lightweight second opinion.",
  },
  perplexity: {
    label: "Perplexity Sonar Pro",
    cost: 1,
    available: true,
    blurb:
      "Web-grounded with live citations. Frames your site the way Perplexity's answer engine would surface it to users.",
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
  const rack = pack.credits * 100;
  if (pack.amountCents >= rack) return 0;
  return Math.round(((rack - pack.amountCents) / rack) * 100);
}
