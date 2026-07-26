// The data model behind the generated OpenGraph card for a shared report.
//
// Kept as a pure function, separate from the image rendering, for two reasons:
// it is the part with real branching (two engines whose scores run in OPPOSITE
// directions, plus three run states), and it can be unit-tested without
// rasterising a PNG.
//
// The card's whole job is to carry the SCANNED SITE'S NAME, so a link pasted
// into Slack or X reads as "acme.com scored 34/100" rather than as a generic
// CrawlProof banner. Everything here serves that headline.

export type CardTone = "pass" | "warn" | "fail" | "neutral";

export type ShareCard = {
  /** Hostname of the scanned site — the headline of the card. */
  host: string;
  /** Which score is being shown; the two run in opposite directions. */
  kind: "aeo" | "slop";
  /** Human label for the number, e.g. "AEO Score". */
  label: string;
  state: "complete" | "pending" | "failed";
  /** null unless state === "complete". */
  score: number | null;
  tone: CardTone;
  /** One line of supporting detail under the score. */
  headline: string;
  /** Direction hint, so a low number is never misread as a bad one. */
  scaleHint: string;
  /** 0–100 width of the meter, matching the number above it. */
  fill: number;
  /** Footer strapline — describes the scan that actually ran. */
  footer: string;
};

export type ShareCardAudit = {
  target_url: string;
  status: string;
  score: number | null;
  engine: string | null;
  summary?: Record<string, unknown> | null;
};

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    // Fall back to the raw string rather than showing nothing — a malformed
    // stored URL should still produce a card.
    return url.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0] || url;
  }
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/**
 * Slop runs 0 = pristine → 100 = maximum slop, so a LOW number is good. This
 * inverts the usual dial and is the single easiest thing to get wrong on a
 * card, where there is no surrounding copy to explain it.
 */
function slopTone(score: number): CardTone {
  if (score <= 25) return "pass";
  if (score <= 50) return "warn";
  return "fail";
}

/** AEO runs the conventional direction: 100 = best. */
function aeoTone(score: number): CardTone {
  if (score >= 80) return "pass";
  if (score >= 50) return "warn";
  return "fail";
}

export function buildShareCard(audit: ShareCardAudit): ShareCard {
  const host = hostOf(audit.target_url);
  const summary = (audit.summary ?? {}) as Record<string, unknown>;
  const slopScore = num(summary.slopScore);
  // Trust the engine column, but fall back to the summary shape: sibling rows
  // in a multi-engine scan_run can carry a null engine.
  const isSlop = audit.engine === "slop" || (audit.engine == null && slopScore !== null);

  const kind = isSlop ? "slop" : "aeo";
  const label = isSlop ? "Slop Score" : "AEO Score";
  const scaleHint = isSlop ? "0 = pristine · 100 = maximum slop" : "out of 100 · higher is better";
  // Name the scan that actually ran — an "SEO · AEO · GEO audit" strapline
  // under a Slop Score is describing a different product.
  const footer = isSlop
    ? "Free carelessness scan — content, code, design"
    : "SEO · AEO · GEO audit — free, no signup";

  if (audit.status === "failed") {
    return {
      host,
      kind,
      label,
      state: "failed",
      score: null,
      tone: "neutral",
      headline: "Scan failed",
      scaleHint,
      fill: 0,
      footer,
    };
  }

  const score = isSlop ? slopScore : num(audit.score);
  if (audit.status !== "complete" || score === null) {
    return {
      host,
      kind,
      label,
      state: "pending",
      score: null,
      tone: "neutral",
      headline: "Scan running…",
      scaleHint,
      fill: 0,
      footer,
    };
  }

  const pages = num(summary.pagesCrawled);
  const parts: string[] = [];

  if (isSlop) {
    const grade = typeof summary.slopGrade === "string" ? summary.slopGrade : null;
    const issues = num(summary.slopIssues);
    if (grade) parts.push(grade);
    if (issues !== null) parts.push(plural(issues, "issue"));
    if (pages !== null) parts.push(`${plural(pages, "page")} swept`);
  } else {
    const fail = num(summary.fail);
    const pass = num(summary.pass);
    if (fail !== null && fail > 0) parts.push(`${plural(fail, "check")} failed`);
    else if (pass !== null) parts.push(`all ${plural(pass, "check")} passed`);
    if (pages !== null) parts.push(`${plural(pages, "page")} crawled`);
  }

  return {
    host,
    kind,
    label,
    state: "complete",
    score,
    tone: isSlop ? slopTone(score) : aeoTone(score),
    // Never leave the line empty — an older row may predate these summary keys.
    headline: parts.length > 0 ? parts.join(" · ") : "See the full report",
    scaleHint,
    // Both dials fill in the direction of their own number, so the bar always
    // agrees with the digits printed above it.
    fill: Math.max(2, Math.min(100, score)),
    footer,
  };
}
