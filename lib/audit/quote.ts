// Remediation quote — "we'll fix this for you" pricing, derived from the
// report's own findings rather than picked out of the air.
//
// Every finding is classified by how it actually gets fixed:
//
//   AI-assisted   work our automation does — metadata, schema, alt text,
//                 template variables, placeholder copy, dead links. This is
//                 the same class of change the GitHub auto-fix agent already
//                 opens PRs for, so it's cheap and fast.
//   Manual        work a human has to do — DNS/registrar changes, infra and
//                 performance work, and anything requiring facts only the
//                 client has: real metrics, customer quotes, product
//                 screenshots, positioning decisions, redirect strategy.
//
// Both are billed at the same hourly rate; the split exists so the client can
// see what they're paying for and why a content-heavy report costs more than a
// markup-heavy one.

import type { Finding } from "./types";

/** Blended hourly rate, USD. */
export const HOURLY_RATE_USD = 100;

/** Score we commit to reaching across every engine in the report. */
export const TARGET_SCORE = 90;

// Sanity ceiling. Past this the engagement is a rebuild, not a remediation,
// and should be scoped by hand rather than quoted off a scan.
const MAX_BILLABLE_HOURS = 120;

// Fixed overhead on any engagement: intake, an implementation plan, a
// verification re-scan per engine, and the handoff writeup. Without this a
// nearly-clean site would quote a couple of hundred dollars, which doesn't
// cover the work of confirming it's actually clean.
const BASELINE = { ai: 1, manual: 3 };

type Effort = { ai: number; manual: number };

// Hours per occurrence. Ordered — first matching rule wins.
const EFFORT_RULES: Array<{ test: RegExp; effort: Effort; label: string }> = [
  // Content that only the client can supply: real numbers, named customers,
  // original screenshots. AI drafts it; a human still has to source the truth.
  {
    test: /^(content\.no_first_party_evidence|content\.thin|slop\.site\.content\.(near_duplicate|boilerplate_intro)|homepage\.word_count|positioning\.|data\.|missing\.)/,
    effort: { ai: 0.5, manual: 1.5 },
    label: "Original content & positioning",
  },
  // Registrar / mail-provider records. No automation can touch these without
  // credentials we don't hold.
  {
    test: /^(dns\.|aibot\.|robots\.|sitemap\.|wellknown\.|spf|dkim|dmarc|mta|bimi)/,
    effort: { ai: 0.2, manual: 0.6 },
    label: "DNS, robots & crawler access",
  },
  // Infra: caching, JS payload, server rendering, headers.
  {
    test: /^(performance\.|homepage\.load_time|content\.text_ratio|render\.|security\.)/,
    effort: { ai: 0.4, manual: 1 },
    label: "Performance & security infrastructure",
  },
  // Template-level defects — fixed once, fixes every page. Higher one-time
  // cost than a single page, far cheaper than the pages it resolves.
  {
    test: /^slop\.systemic\./,
    effort: { ai: 1, manual: 0.5 },
    label: "Shared template fixes",
  },
  // Per-page slop. Deliberately cheap per page: most instances are resolved by
  // the template fix above, and the rest are mechanical.
  {
    test: /^slop\.page\./,
    effort: { ai: 0.15, manual: 0.1 },
    label: "Per-page cleanup",
  },
  // Structured data.
  {
    test: /^(schema\.|spec\.)/,
    effort: { ai: 0.4, manual: 0.15 },
    label: "Schema & structured data",
  },
  // Markup, metadata, links, images — the automation's home turf.
  {
    test: /^(homepage\.|meta\.|content\.|links\.|images\.|geo\.|slop\.site\.)/,
    effort: { ai: 0.35, manual: 0.1 },
    label: "Markup, metadata & media",
  },
];

const DEFAULT_EFFORT: Effort = { ai: 0.3, manual: 0.2 };
const DEFAULT_LABEL = "Other findings";

// Findings that are summaries or scaffolding, not work items — counting them
// would bill the client twice for the same defect.
const NON_BILLABLE =
  /^(rec\.|todo\.|slop\.score$|slop\.coverage$|crawl\.|links\.crawl_coverage$)/;

export type QuoteDriver = {
  label: string;
  count: number;
  aiHours: number;
  manualHours: number;
};

export type Quote = {
  rateUsd: number;
  targetScore: number;
  aiHours: number;
  manualHours: number;
  totalHours: number;
  amountUsd: number;
  issueCount: number;
  drivers: QuoteDriver[];
  /** True when the estimate hit the ceiling and needs a human to scope it. */
  cappedForScoping: boolean;
};

function roundHalf(n: number): number {
  return Math.round(n * 2) / 2;
}

/**
 * Price a remediation engagement from a report's findings.
 *
 * Only `fail` and `warn` findings are billable — a `pass` is not work. The
 * result is rounded to the nearest half-hour and $100 so it reads as a quote
 * rather than a spreadsheet cell.
 */
export function quoteFromFindings(findings: Finding[]): Quote {
  // Deduplicate by check_key, keeping the worst status. A consolidated
  // scan-run report contains one findings set per engine, and several engines
  // flag the same defect (a missing meta description is one fix, whether
  // Claude, Gemini and the rule engine all noticed it or only one did).
  // Without this the same work is billed once per engine that spotted it.
  const worst = new Map<string, Finding>();
  for (const f of findings) {
    if (f.status !== "fail" && f.status !== "warn") continue;
    if (NON_BILLABLE.test(f.check_key)) continue;
    const seen = worst.get(f.check_key);
    if (!seen || (seen.status === "warn" && f.status === "fail")) {
      worst.set(f.check_key, f);
    }
  }
  const billable = Array.from(worst.values());

  const byLabel = new Map<string, QuoteDriver>();
  let ai = BASELINE.ai;
  let manual = BASELINE.manual;

  for (const f of billable) {
    const rule = EFFORT_RULES.find((r) => r.test.test(f.check_key));
    const effort = rule?.effort ?? DEFAULT_EFFORT;
    const label = rule?.label ?? DEFAULT_LABEL;
    // A `warn` is a partial defect — it costs less to clear than a hard fail.
    const weight = f.status === "fail" ? 1 : 0.6;
    const aiHours = effort.ai * weight;
    const manualHours = effort.manual * weight;
    ai += aiHours;
    manual += manualHours;

    const existing = byLabel.get(label);
    if (existing) {
      existing.count += 1;
      existing.aiHours += aiHours;
      existing.manualHours += manualHours;
    } else {
      byLabel.set(label, { label, count: 1, aiHours, manualHours });
    }
  }

  let aiHours = roundHalf(ai);
  let manualHours = roundHalf(manual);
  let cappedForScoping = false;
  if (aiHours + manualHours > MAX_BILLABLE_HOURS) {
    // Scale both down proportionally so the split stays meaningful, and flag
    // that the real number needs a conversation.
    const scale = MAX_BILLABLE_HOURS / (aiHours + manualHours);
    aiHours = roundHalf(aiHours * scale);
    manualHours = roundHalf(manualHours * scale);
    cappedForScoping = true;
  }

  const totalHours = aiHours + manualHours;
  const amountUsd = Math.round((totalHours * HOURLY_RATE_USD) / 100) * 100;

  const drivers = Array.from(byLabel.values())
    .map((d) => ({
      ...d,
      aiHours: roundHalf(d.aiHours),
      manualHours: roundHalf(d.manualHours),
    }))
    .sort((a, b) => b.aiHours + b.manualHours - (a.aiHours + a.manualHours));

  return {
    rateUsd: HOURLY_RATE_USD,
    targetScore: TARGET_SCORE,
    aiHours,
    manualHours,
    totalHours,
    amountUsd,
    issueCount: billable.length,
    drivers,
    cappedForScoping,
  };
}

/**
 * Fallback when only summary counts are on hand (e.g. a consolidated scan-run
 * PDF assembled from rows that carry counts but not findings). Uses the
 * blended default effort, so it lands in the same ballpark without pretending
 * to know which categories are involved.
 */
export function quoteFromCounts(input: { warn: number; fail: number }): Quote {
  const synthetic: Finding[] = [
    ...Array.from({ length: Math.max(0, input.fail) }, (_, i) => ({
      section: "Summary",
      check_key: `synthetic.fail_${i}`,
      status: "fail" as const,
      title: "",
      priority: 2 as const,
    })),
    ...Array.from({ length: Math.max(0, input.warn) }, (_, i) => ({
      section: "Summary",
      check_key: `synthetic.warn_${i}`,
      status: "warn" as const,
      title: "",
      priority: 3 as const,
    })),
  ];
  return quoteFromFindings(synthetic);
}

export function formatUsd(amount: number): string {
  return `$${amount.toLocaleString("en-US")}`;
}

/** Hours, printed without a trailing ".0". */
export function formatHours(h: number): string {
  return `${Number.isInteger(h) ? h : h.toFixed(1)}h`;
}
