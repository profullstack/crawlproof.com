// Window-over-window trend maths for the portfolio analytics page.
//
// Every figure on that page compares the current N-day window against the N
// days immediately before it, so "is this going up, down, or sideways?" has a
// single consistent definition across the headline metrics and the per-project
// table.

export type TrendDirection = "up" | "down" | "flat";

export type Trend = {
  current: number;
  previous: number;
  /** Percent change vs the previous window; null when there is no baseline. */
  changePct: number | null;
  direction: TrendDirection;
  /**
   * Both windows are small enough that the percentage is mostly noise. The
   * direction is still reported honestly — this just lets the UI soften how
   * loudly it says so.
   */
  lowVolume: boolean;
};

/** Below this much movement, a window counts as sideways rather than a trend. */
export const FLAT_BAND_PCT = 5;

/** Under this many events in both windows, percentages swing wildly. */
export const LOW_VOLUME_EVENTS = 20;

export function computeTrend(
  current: number,
  previous: number,
  { flatBandPct = FLAT_BAND_PCT, lowVolumeAt = LOW_VOLUME_EVENTS } = {},
): Trend {
  const lowVolume = Math.max(current, previous) < lowVolumeAt;

  // No baseline: percent change is undefined rather than infinite. Traffic
  // appearing where there was none is still a genuine "up".
  if (previous === 0) {
    return {
      current,
      previous,
      changePct: null,
      direction: current > 0 ? "up" : "flat",
      lowVolume,
    };
  }

  const changePct = ((current - previous) / previous) * 100;
  const direction: TrendDirection =
    Math.abs(changePct) < flatBandPct ? "flat" : changePct > 0 ? "up" : "down";

  return { current, previous, changePct, direction, lowVolume };
}

export function trendArrow(direction: TrendDirection) {
  return direction === "up" ? "▲" : direction === "down" ? "▼" : "▬";
}

/** Short label for a trend chip, e.g. "▲ 12.4%", "▬ flat", "▲ new". */
export function formatTrend(trend: Trend) {
  const arrow = trendArrow(trend.direction);
  if (trend.changePct === null) {
    return trend.current > 0 ? `${arrow} new` : `${arrow} no data`;
  }
  const magnitude = Math.abs(trend.changePct);
  const rounded = magnitude >= 100 ? Math.round(magnitude) : Number(magnitude.toFixed(1));
  return `${arrow} ${rounded.toLocaleString()}%`;
}

/**
 * The one-line verdict for the whole portfolio. Uses the aggregate trend but
 * also counts how the individual properties split, because "up 8% overall"
 * means something different when one site carries it than when nine do.
 */
export function portfolioVerdict(
  overall: Trend,
  perProject: TrendDirection[],
): string {
  const up = perProject.filter((d) => d === "up").length;
  const down = perProject.filter((d) => d === "down").length;
  const flat = perProject.filter((d) => d === "flat").length;
  const total = perProject.length;

  if (total === 0) return "No traffic recorded yet across your properties.";

  const split = `${up} up · ${flat} sideways · ${down} down`;
  const headline =
    overall.direction === "up"
      ? "Your portfolio is growing"
      : overall.direction === "down"
        ? "Your portfolio is shrinking"
        : "Your portfolio is holding steady";

  const change =
    overall.changePct === null
      ? ""
      : ` ${formatTrend(overall).replace(/^[▲▼▬] /, overall.direction === "down" ? "down " : overall.direction === "up" ? "up " : "within ")}`;

  return `${headline}${change} vs the previous window — ${split} of ${total} ${
    total === 1 ? "property" : "properties"
  }.`;
}
