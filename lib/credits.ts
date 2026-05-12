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

// ----- Engines (rule, Claude, OpenAI, Qwen, Kimi, Gemini) -----------------
export type Engine = "rule" | "claude" | "openai" | "qwen" | "kimi" | "gemini";

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
    label: "OpenAI GPT-5",
    cost: 1,
    available: true,
    blurb:
      "OpenAI's flagship with web search. Second opinion framed the way an OpenAI-tier answer engine would.",
  },
  qwen: {
    label: "Qwen 3 (Coming soon)",
    cost: 1,
    available: false,
    blurb: "Alibaba's frontier model. Wires up when DASHSCOPE / Qwen API keys are configured.",
  },
  kimi: {
    label: "Kimi K2 (Coming soon)",
    cost: 1,
    available: false,
    blurb: "Moonshot AI's flagship. Wires up when MOONSHOT API keys are configured.",
  },
  gemini: {
    label: "Gemini 2.5 Pro (Coming soon)",
    cost: 1,
    available: false,
    blurb: "Google's flagship with Search grounding. Wires up when GEMINI_API_KEY is configured.",
  },
};

export function engineCost(engine: Engine): number {
  return ENGINES[engine].cost;
}

export function engineAvailable(engine: Engine): boolean {
  return ENGINES[engine].available;
}

export function discountPct(pack: CreditPack): number {
  const rack = pack.credits * 100;
  if (pack.amountCents >= rack) return 0;
  return Math.round(((rack - pack.amountCents) / rack) * 100);
}
