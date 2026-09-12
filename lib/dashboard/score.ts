// The risk-to-viral score: which property is worth another week of attention.
//
// WHY a score at all. The Traffic screen ranks sites by visitors, and visitors
// is the one number on this fleet that lies — most of it is crawler traffic
// (lib/tracker/humans.ts), and on a site with a machine-readable endpoint a
// "visitor" is any hit that was not classified as a crawler, which runs orders
// of magnitude above the pages anyone read. So the busiest row is routinely the
// least interesting one. This ranks by the thing that is actually being asked:
// is this property going anywhere, and how fragile is the answer.
//
// It is deliberately arithmetic rather than a model. Every component is one
// division over numbers already on the screen, every weight is written down
// here and rendered on the domain screen, and a component with no data is
// dropped and its weight redistributed rather than counted as a zero. A score
// nobody can take apart is a score nobody should act on.
//
// ── THE FORMULA ────────────────────────────────────────────────────────────
//
// Two halves, each a weighted mean of components in 0..1.
//
//   VIRAL — the upside
//     momentum   0.40  human visits in the recent half of the window against
//                      the earlier half: g = (recent - prior) / max(prior, 1),
//                      scored 0.5 + g/2, so flat is 0.5, doubling is 1.0 and
//                      losing everything is 0.
//     discovery  0.30  share of human arrivals from a channel a stranger can
//                      come through — search, social, AI referral, ad, another
//                      site's link — rather than direct or our own referral.
//                      Reach that compounds, as opposed to reach we already had.
//     humanity   0.20  humans / (humans + bots). Needs the unfiltered mix; when
//                      the window was asked for one side only it is unknown and
//                      this component is dropped rather than assumed.
//     money      0.10  revenue per 1,000 human visits against TARGET_RPM_USD.
//                      Small on purpose: nothing on this fleet is monetised yet
//                      and weighting it heavily would score every property 0.
//
//   RISK — the fragility, which is what "risk-to-viral" names
//     volatility     0.40  coefficient of variation of the human series over
//                          the window, against CV_CEILING.
//     concentration  0.30  the largest single arrival channel's share, rescaled
//                          from CONCENTRATION_FLOOR..1 onto 0..1: an even split
//                          across channels is not a risk, one channel being
//                          everything is the whole risk.
//     botDependence  0.20  1 - humanity.
//     unmonetised    0.10  1 - money.
//
//   score = 100 × viral × (1 − risk / 2)
//
// So risk can halve a property's score and never more, and a property with no
// upside scores 0 however safe it is — which is the right shape for a question
// about where to spend the next week.
//
// Every input is coerced, every denominator is guarded, and nothing here can
// return NaN or Infinity: see `clamp01` and the `safeDiv` calls.

/** Revenue per 1,000 human visits that counts as fully monetised. */
export const TARGET_RPM_USD = 2;

/** Coefficient of variation at which the volatility component saturates. */
export const CV_CEILING = 1.5;

/** Below this share, one dominant channel is not yet counted as a risk. */
export const CONCENTRATION_FLOOR = 0.5;

/** Human visits below which a score is labelled provisional rather than read. */
export const MIN_SAMPLE_HUMANS = 25;

export const VIRAL_WEIGHTS = {
  momentum: 0.4,
  discovery: 0.3,
  humanity: 0.2,
  money: 0.1,
} as const;

export const RISK_WEIGHTS = {
  volatility: 0.4,
  concentration: 0.3,
  botDependence: 0.2,
  unmonetised: 0.1,
} as const;

/**
 * Arrival buckets a stranger can reach us through.
 *
 * `bucketLabel` in lib/tracker/categorize.ts renders the bucket as
 * "Search · google", "AI · chatgpt" and so on, and the dashboard carries those
 * labels rather than the raw buckets, so both spellings are matched here.
 * "Direct" and a self-referral are reach we already had; they are not counted.
 */
const DISCOVERY_PREFIXES = ["search", "social", "ai", "ad", "referral", "ai_referral"];

const num = (v: unknown): number => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};

/**
 * 0..1, with NaN ordered to 0 rather than propagated.
 *
 * Infinity saturates rather than falling to zero: an unbounded ratio means the
 * component is off the top of its scale, and reading that as "nothing here"
 * would score the most volatile property as the safest one.
 */
export function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** A ratio, or null when the denominator cannot carry one. */
function safeDiv(top: number, bottom: number): number | null {
  if (!Number.isFinite(top) || !Number.isFinite(bottom) || bottom <= 0) return null;
  const out = top / bottom;
  return Number.isFinite(out) ? out : null;
}

export type ScoreItem = { label: string; value: number };

export type ScoreInput = {
  /** Human visits per bucket across the window, oldest first. */
  humans: number[];
  /** Bot hits per bucket, from the unfiltered mix. Empty when it is unknown. */
  bots?: number[];
  /** Arrival channels for the window, as the dashboard already carries them. */
  sources?: ScoreItem[];
  /** Money attributable to this property over the window, in dollars. */
  revenueUsd?: number;
  /**
   * Human visits over the window, when a truer total than the series sum is
   * known. The series is filtered to whichever side was asked for, so under
   * `who=bots` its human column is zero by construction; the unfiltered mix
   * knows the real figure and this is where it comes in.
   */
  humansTotal?: number;
  /** Bot hits over the window, from the same unfiltered read. */
  botsTotal?: number;
  /**
   * True when the mix of humans against bots is known for this window. It is
   * not when the caller asked for one side only and nothing counted the other.
   */
  mixKnown?: boolean;
};

export type Component = {
  key: string;
  label: string;
  /** 0..1, or null when there was nothing to compute it from. */
  value: number | null;
  weight: number;
  /** The raw figure behind the component, for the detail screen. */
  detail: string;
};

export type ScoreModel = {
  /** 0..100, or null when neither half could be computed. */
  score: number | null;
  /** 0..1. */
  viral: number;
  /** 0..1. */
  risk: number;
  viralComponents: Component[];
  riskComponents: Component[];
  /** Human visits the score was computed over. */
  humans: number;
  /** True when the sample is too small to lean on. */
  provisional: boolean;
  /** Share of the weight that had data behind it, across both halves. */
  coverage: number;
  /** Why a component is missing, or why the score should not be read straight. */
  notes: string[];
};

const sum = (values: number[]): number => values.reduce((total, v) => total + num(v), 0);

/**
 * Growth of the recent half of the window against the earlier half.
 *
 * Halves rather than a fitted trend because the window is as short as thirteen
 * five-minute buckets and as long as thirty days, and a fit over thirteen noisy
 * buckets says more about the noise than the site. Null when there are fewer
 * than four buckets, which is the point below which "recent" and "earlier" are
 * the same two numbers.
 */
export function growthRate(series: number[]): number | null {
  const points = (series ?? []).map(num);
  if (points.length < 4) return null;
  const mid = Math.floor(points.length / 2);
  const prior = sum(points.slice(0, mid));
  const recent = sum(points.slice(mid));
  if (prior <= 0 && recent <= 0) return null;
  // max(prior, 1) rather than a guard: from nothing to something is growth, and
  // dividing by zero to say so is not.
  return (recent - prior) / Math.max(prior, 1);
}

/**
 * Coefficient of variation: standard deviation over the mean.
 *
 * Scale-free on purpose, so a site doing 20 visits a day and one doing 20,000
 * are asked the same question — how steady is it — rather than the larger one
 * always reading as the more volatile.
 */
export function coefficientOfVariation(series: number[]): number | null {
  const points = (series ?? []).map(num);
  if (points.length < 3) return null;
  const mean = sum(points) / points.length;
  if (mean <= 0) return null;
  const variance = points.reduce((total, v) => total + (v - mean) ** 2, 0) / points.length;
  const cv = safeDiv(Math.sqrt(variance), mean);
  return cv === null ? null : cv;
}

/** Share of arrivals from a channel a stranger can come through. */
export function discoveryShare(sources: ScoreItem[] | undefined): number | null {
  const items = (sources ?? []).filter((s) => s && typeof s.label === "string");
  const total = sum(items.map((s) => num(s.value)));
  if (total <= 0) return null;
  const discovered = items
    .filter((s) => {
      const head = s.label.split("·")[0]?.trim().toLowerCase() ?? "";
      return DISCOVERY_PREFIXES.some((p) => head === p || head.startsWith(`${p}:`) || head.startsWith(`${p} `));
    })
    .reduce((t, s) => t + num(s.value), 0);
  return clamp01(discovered / total);
}

/** The largest single channel's share of arrivals. */
export function topSourceShare(sources: ScoreItem[] | undefined): number | null {
  const values = (sources ?? []).map((s) => num(s?.value)).filter((v) => v > 0);
  const total = sum(values);
  if (total <= 0) return null;
  return clamp01(Math.max(...values) / total);
}

/** A weighted mean over the components that have a value, weights renormalised. */
function weightedMean(components: Component[]): { value: number; weight: number } {
  let weighted = 0;
  let weight = 0;
  for (const c of components) {
    if (c.value === null) continue;
    weighted += clamp01(c.value) * c.weight;
    weight += c.weight;
  }
  return { value: weight > 0 ? weighted / weight : 0, weight };
}

const pct = (v: number | null): string => (v === null ? "no data" : `${(v * 100).toFixed(0)}%`);

/**
 * Score one property. Pure, total, and safe against every empty shape: an input
 * of `{ humans: [] }` returns a null score with notes, never a NaN.
 */
export function scoreSite(input: ScoreInput): ScoreModel {
  const humansSeries = (input.humans ?? []).map(num);
  const botsSeries = (input.bots ?? []).map(num);
  const humans = input.humansTotal === undefined ? sum(humansSeries) : num(input.humansTotal);
  const bots = input.botsTotal === undefined ? sum(botsSeries) : num(input.botsTotal);
  const notes: string[] = [];

  const growth = growthRate(humansSeries);
  if (growth === null && humansSeries.length < 4) {
    notes.push("Too few buckets in this window to measure growth; widen it with w.");
  }

  const mixKnown = input.mixKnown !== false && (humans > 0 || bots > 0);
  const humanity = mixKnown ? safeDiv(humans, humans + bots) : null;
  if (!mixKnown) {
    notes.push("Humans against bots is unknown for this window, so that component is not counted.");
  }

  const discovery = discoveryShare(input.sources);
  const concentrationRaw = topSourceShare(input.sources);
  const cv = coefficientOfVariation(humansSeries);

  const revenueUsd = num(input.revenueUsd);
  const rpm = safeDiv(revenueUsd * 1000, humans);
  const money = rpm === null ? null : clamp01(rpm / TARGET_RPM_USD);

  const viralComponents: Component[] = [
    {
      key: "momentum",
      label: "Momentum",
      value: growth === null ? null : clamp01(0.5 + growth / 2),
      weight: VIRAL_WEIGHTS.momentum,
      detail:
        growth === null
          ? "no data"
          : `${growth >= 0 ? "+" : ""}${(growth * 100).toFixed(0)}% human visits, recent half vs earlier`,
    },
    {
      key: "discovery",
      label: "Discovery",
      value: discovery,
      weight: VIRAL_WEIGHTS.discovery,
      detail: discovery === null ? "no arrivals" : `${pct(discovery)} arrived via search, social, AI, ad or a link`,
    },
    {
      key: "humanity",
      label: "Humanity",
      value: humanity,
      weight: VIRAL_WEIGHTS.humanity,
      detail:
        humanity === null
          ? "mix unknown"
          : `${humans.toLocaleString("en-US")} human of ${(humans + bots).toLocaleString("en-US")} hits`,
    },
    {
      key: "money",
      label: "Money",
      value: money,
      weight: VIRAL_WEIGHTS.money,
      detail:
        rpm === null
          ? "no human visits to divide by"
          : `$${rpm.toFixed(2)} per 1k human visits (target $${TARGET_RPM_USD.toFixed(2)})`,
    },
  ];

  const concentration =
    concentrationRaw === null
      ? null
      : clamp01((concentrationRaw - CONCENTRATION_FLOOR) / (1 - CONCENTRATION_FLOOR));

  const riskComponents: Component[] = [
    {
      key: "volatility",
      label: "Volatility",
      value: cv === null ? null : clamp01(cv / CV_CEILING),
      weight: RISK_WEIGHTS.volatility,
      detail: cv === null ? "no data" : `CV ${cv.toFixed(2)} across ${humansSeries.length} buckets`,
    },
    {
      key: "concentration",
      label: "Channel concentration",
      value: concentration,
      weight: RISK_WEIGHTS.concentration,
      detail:
        concentrationRaw === null
          ? "no arrivals"
          : `biggest channel is ${pct(concentrationRaw)} of arrivals`,
    },
    {
      key: "botDependence",
      label: "Bot dependence",
      value: humanity === null ? null : clamp01(1 - humanity),
      weight: RISK_WEIGHTS.botDependence,
      detail: humanity === null ? "mix unknown" : `${pct(humanity === null ? null : 1 - humanity)} of hits are crawlers`,
    },
    {
      key: "unmonetised",
      label: "Unmonetised",
      value: money === null ? null : clamp01(1 - money),
      weight: RISK_WEIGHTS.unmonetised,
      detail: rpm === null ? "no revenue basis" : `$${revenueUsd.toFixed(2)} attributable in this window`,
    },
  ];

  const viral = weightedMean(viralComponents);
  const risk = weightedMean(riskComponents);
  const totalWeight = viral.weight + risk.weight;
  const coverage = clamp01(totalWeight / 2);

  const provisional = humans < MIN_SAMPLE_HUMANS;
  if (provisional) {
    notes.push(
      `Only ${humans.toLocaleString("en-US")} human visits in this window; under ${MIN_SAMPLE_HUMANS} the score is a guess with error bars.`,
    );
  }

  // Nothing at all is a real answer and should read as one, rather than as the
  // zero a property that was measured and found dead would get.
  const score = viral.weight <= 0 && risk.weight <= 0 ? null : 100 * viral.value * (1 - risk.value / 2);

  return {
    score: score === null ? null : Math.round(score * 10) / 10,
    viral: viral.value,
    risk: risk.value,
    viralComponents,
    riskComponents,
    humans,
    provisional,
    coverage,
    notes,
  };
}

/** The one-line explanation the CLI help, the README and the screen all use. */
export const SCORE_FORMULA =
  "score = 100 × viral × (1 − risk/2), where viral is momentum .40 + discovery .30 + humanity .20 + money .10 " +
  "and risk is volatility .40 + channel concentration .30 + bot dependence .20 + unmonetised .10. " +
  "Components with no data are dropped and their weight redistributed.";
