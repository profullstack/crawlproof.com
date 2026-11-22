// A/B test statistics: conversion rate per arm with a Wilson interval, a pooled
// two-proportion z test against the control, the Bayesian probability that an
// arm beats the control (exact Beta posterior comparison, uniform prior), the
// sample size a gap needs before it can be called, and a plain-language verdict.
//
// No dependencies, deterministic (no sampling), safe in Node, Bun and browsers.

/** Standard normal CDF (Abramowitz-Stegun 7.1.26 through erf; |error| < 1.5e-7). */
export function normalCdf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y =
    1 -
    (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t) *
      Math.exp(-(x * x) / 2);
  return x >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

/** Inverse standard normal CDF (Acklam's rational approximation, rel. error < 1.2e-9). */
export function normalQuantile(p: number): number {
  if (!(p > 0 && p < 1)) throw new RangeError("normalQuantile needs 0 < p < 1");
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425;
  if (p < lo) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - lo) return -normalQuantile(1 - p);
  const q = p - 0.5;
  const r = q * q;
  return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

export type Interval = { low: number; high: number };

/**
 * Wilson score interval for a binomial proportion. At 0 successes the lower bound is
 * exactly 0 and at n successes the upper bound is exactly 1 (floating point otherwise
 * lands a hair outside the observed rate).
 */
export function wilson(successes: number, n: number, confidence = 0.95): Interval {
  if (!(n > 0)) return { low: 0, high: 1 };
  const z = normalQuantile(1 - (1 - confidence) / 2);
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return {
    low: successes <= 0 ? 0 : Math.max(0, centre - half),
    high: successes >= n ? 1 : Math.min(1, centre + half),
  };
}

export type ZTest = { z: number; pValue: number };

/** Pooled two-proportion z test, two-sided. B against A. */
export function twoProportionZ(convA: number, nA: number, convB: number, nB: number): ZTest {
  if (!(nA > 0 && nB > 0)) return { z: 0, pValue: 1 };
  const pooled = (convA + convB) / (nA + nB);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / nA + 1 / nB));
  if (!(se > 0)) return { z: 0, pValue: 1 };
  const z = (convB / nB - convA / nA) / se;
  return { z, pValue: Math.min(1, 2 * (1 - normalCdf(Math.abs(z)))) };
}

/** ln Γ(x) for x > 0 (Lanczos, g = 7). */
export function logGamma(x: number): number {
  const g = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  const xx = x - 1;
  let a = g[0];
  const t = xx + 7.5;
  for (let i = 1; i < 9; i++) a += g[i] / (xx + i);
  return 0.5 * Math.log(2 * Math.PI) + (xx + 0.5) * Math.log(t) - t + Math.log(a);
}

const logBeta = (a: number, b: number) => logGamma(a) + logGamma(b) - logGamma(a + b);

/**
 * P(rate_B > rate_A) with independent Beta(1 + conv, 1 + n - conv) posteriors.
 * Exact sum (Evan Miller's closed form) while B has at most 20,000 conversions,
 * a normal approximation of the two posteriors past that.
 */
export function probabilityToBeat(convA: number, nA: number, convB: number, nB: number): number {
  const aA = 1 + convA;
  const bA = 1 + Math.max(0, nA - convA);
  const aB = 1 + convB;
  const bB = 1 + Math.max(0, nB - convB);
  if (aB - 1 <= 20_000) {
    let total = 0;
    const lbA = logBeta(aA, bA);
    for (let i = 0; i < aB; i++) {
      total += Math.exp(logBeta(aA + i, bA + bB) - Math.log(bB + i) - logBeta(1 + i, bB) - lbA);
    }
    return Math.min(1, Math.max(0, total));
  }
  const mean = (a: number, b: number) => a / (a + b);
  const variance = (a: number, b: number) => (a * b) / ((a + b) ** 2 * (a + b + 1));
  const sd = Math.sqrt(variance(aA, bA) + variance(aB, bB));
  return normalCdf((mean(aB, bB) - mean(aA, bA)) / sd);
}

/**
 * Units needed PER ARM for a two-sided two-proportion test to detect rateA vs rateB
 * at the given alpha and power. Infinity when the rates are equal.
 */
export function sampleSizePerArm(rateA: number, rateB: number, alpha = 0.05, power = 0.8): number {
  const delta = Math.abs(rateB - rateA);
  if (!(delta > 0)) return Infinity;
  const za = normalQuantile(1 - alpha / 2);
  const zb = normalQuantile(power);
  const pBar = (rateA + rateB) / 2;
  const n = (za * Math.sqrt(2 * pBar * (1 - pBar)) + zb * Math.sqrt(rateA * (1 - rateA) + rateB * (1 - rateB))) ** 2 / delta ** 2;
  return Math.ceil(n);
}

// ---------------------------------------------------------------- experiment summary

export type ArmCounts = {
  arm: string;
  /** Units assigned to the arm. */
  assigned?: number;
  /** Units that saw the treatment (the denominator for conversion). */
  exposed: number;
  /** Exposed units that converted at least once. */
  converted: number;
  /** Sum of revenue events. */
  revenue?: number;
  /** Named engagement events: units that did it at least once, and how many times in all. */
  events?: Record<string, { units: number; count: number }>;
};

export type ArmSummary = Required<Pick<ArmCounts, "arm" | "exposed" | "converted">> & {
  assigned: number;
  revenue: number;
  isControl: boolean;
  rate: number;
  ci: Interval;
  /** Relative lift of the rate against the control (0.25 = +25%); null for the control or a 0 control rate. */
  lift: number | null;
  /** Two-sided p value of this arm against the control; null for the control. */
  pValue: number | null;
  /** P(this arm's true rate > the control's); null for the control. */
  probabilityToBeatControl: number | null;
  revenuePerExposed: number;
  events: Record<string, { units: number; count: number; perExposed: number }>;
};

export type VerdictStatus = "collecting" | "keep-running" | "significant" | "no-difference";

export type Summary = {
  control: string;
  alpha: number;
  minPerArm: number;
  arms: ArmSummary[];
  verdict: {
    status: VerdictStatus;
    winner: string | null;
    /** Exposed units each arm needs to settle the gap observed so far (null when it cannot be estimated). */
    neededPerArm: number | null;
    text: string;
  };
};

export type SummaryOptions = {
  /** Arm key of the control. Default: the first arm. */
  control?: string;
  /** Significance level. Default 0.05. */
  alpha?: number;
  /** Exposed units each arm needs before any verdict is read. Default 100. */
  minPerArm?: number;
};

const pct = (x: number) => `${(x * 100).toFixed(x < 0.1 ? 2 : 1)}%`;

/**
 * Summarise an experiment. Advice baked in: run two arms, judge on conversions (not
 * opens or clicks that undercount), and only big gaps settle on small traffic.
 */
export function summarize(input: ArmCounts[], opts: SummaryOptions = {}): Summary {
  const alpha = opts.alpha ?? 0.05;
  const minPerArm = opts.minPerArm ?? 100;
  if (input.length === 0) {
    return { control: opts.control ?? "", alpha, minPerArm, arms: [], verdict: { status: "collecting", winner: null, neededPerArm: null, text: "No arms yet." } };
  }
  const control = opts.control && input.some((a) => a.arm === opts.control) ? opts.control : input[0].arm;
  const ctl = input.find((a) => a.arm === control)!;
  const ctlRate = ctl.exposed > 0 ? ctl.converted / ctl.exposed : 0;

  const arms: ArmSummary[] = input.map((a) => {
    const isControl = a.arm === control;
    const rate = a.exposed > 0 ? a.converted / a.exposed : 0;
    const revenue = a.revenue ?? 0;
    const events: ArmSummary["events"] = {};
    for (const [name, e] of Object.entries(a.events ?? {})) {
      events[name] = { units: e.units, count: e.count, perExposed: a.exposed > 0 ? e.count / a.exposed : 0 };
    }
    return {
      arm: a.arm,
      assigned: a.assigned ?? a.exposed,
      exposed: a.exposed,
      converted: a.converted,
      revenue,
      isControl,
      rate,
      ci: wilson(a.converted, a.exposed),
      lift: isControl || ctlRate === 0 ? null : rate / ctlRate - 1,
      pValue: isControl ? null : twoProportionZ(ctl.converted, ctl.exposed, a.converted, a.exposed).pValue,
      probabilityToBeatControl: isControl ? null : probabilityToBeat(ctl.converted, ctl.exposed, a.converted, a.exposed),
      revenuePerExposed: a.exposed > 0 ? revenue / a.exposed : 0,
      events,
    };
  });

  const challengers = arms.filter((a) => !a.isControl);
  const smallest = Math.min(...arms.map((a) => a.exposed));
  const advice = arms.length > 2 ? ` ${arms.length} arms split the traffic ${arms.length} ways; two arms settle faster.` : "";

  if (smallest < minPerArm) {
    return {
      control,
      alpha,
      minPerArm,
      arms,
      verdict: {
        status: "collecting",
        winner: null,
        neededPerArm: minPerArm,
        text: `Collecting: every arm needs ${minPerArm} exposed units before anything is read (smallest has ${smallest}).${advice}`,
      },
    };
  }

  // Best challenger by rate; Bonferroni across challengers keeps a many-arm test honest.
  const best = challengers.reduce((x, y) => (y.rate > x.rate ? y : x), challengers[0]);
  const adjAlpha = alpha / Math.max(1, challengers.length);
  const sig = challengers.filter((a) => (a.pValue ?? 1) < adjAlpha);
  if (sig.length > 0) {
    const top = sig.reduce((x, y) => (y.rate > x.rate ? y : x), sig[0]);
    const winner = top.rate > ctlRate ? top : arms.find((a) => a.isControl)!;
    const loser = winner.isControl ? top : arms.find((a) => a.isControl)!;
    return {
      control,
      alpha,
      minPerArm,
      arms,
      verdict: {
        status: "significant",
        winner: winner.arm,
        neededPerArm: null,
        text: `${winner.arm} wins: ${pct(winner.rate)} vs ${pct(loser.rate)} for ${loser.arm} (p = ${top.pValue!.toPrecision(2)}, P(${top.arm} beats ${control}) = ${pct(top.probabilityToBeatControl!)}).`,
      },
    };
  }

  if (best.rate === ctlRate) {
    return {
      control,
      alpha,
      minPerArm,
      arms,
      verdict: { status: "no-difference", winner: null, neededPerArm: null, text: `No difference so far: every arm converts at ${pct(ctlRate)}.${advice}` },
    };
  }

  const needed = sampleSizePerArm(ctlRate, best.rate, adjAlpha);
  const far = Number.isFinite(needed) && needed > 10 * smallest;
  return {
    control,
    alpha,
    minPerArm,
    arms,
    verdict: {
      status: "keep-running",
      winner: null,
      neededPerArm: Number.isFinite(needed) ? needed : null,
      text:
        `Keep running: ${best.arm} ${pct(best.rate)} vs ${control} ${pct(ctlRate)} is still noise at this size ` +
        `(p = ${best.pValue!.toPrecision(2)}, P(beats control) = ${pct(best.probabilityToBeatControl!)}). ` +
        `Settling this gap needs about ${Number.isFinite(needed) ? needed.toLocaleString("en-US") : "?"} exposed units per arm (smallest has ${smallest}).` +
        (far ? " A gap this small may never settle at this traffic: only big gaps settle on small samples." : "") +
        advice,
    },
  };
}
