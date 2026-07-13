// Ad auction. Selection is a BID-WEIGHTED LOTTERY: every eligible campaign can
// win, with probability proportional to its score (== bid in credits today).
// Higher bids win MORE often, but no single top bid monopolizes delivery — over
// many fills each campaign's impression share converges to its share of the
// total bid weight. The winner is charged its own bid (first-price settlement
// still happens in resolveClick). This replaces the earlier winner-take-all
// design, which starved every campaign that wasn't tied for the single highest
// bid. The scoring step remains the seam where future factors (CTR/quality
// score, pacing weight, frequency capping) plug in without changing callers.
// It IS live today: serveAd runs every fill through runAuction.

export type BidCandidate<T> = {
  /** The campaign's bid, in credits. */
  bidCredits: number;
  item: T;
};

export type AuctionResult<T> = {
  winner: T;
  bidCredits: number;
} | null;

// Floor on the lottery weight so a 0-bid (or somehow non-positive) campaign
// still rotates occasionally instead of never serving — "all ads rotate" is a
// hard requirement, so no eligible candidate ever gets a zero-probability slot.
const MIN_WEIGHT = 0.001;

// Lottery weight for a bid. Extend this to fold in quality/pacing later
// (e.g. divide by impressions-so-far to even out delivery). Today weight == bid.
function score(bidCredits: number): number {
  return bidCredits;
}

export function runAuction<T>(candidates: BidCandidate<T>[]): AuctionResult<T> {
  if (candidates.length === 0) return null;

  const scored = candidates.map((c) => ({
    ...c,
    w: Math.max(score(c.bidCredits), MIN_WEIGHT),
  }));
  const total = scored.reduce((sum, c) => sum + c.w, 0);

  // Weighted random pick: walk the cumulative weight until we cross r.
  let r = Math.random() * total;
  for (const c of scored) {
    r -= c.w;
    if (r < 0) return { winner: c.item, bidCredits: c.bidCredits };
  }

  // Floating-point guard: if rounding left r >= 0, award the last candidate.
  const last = scored[scored.length - 1];
  return { winner: last.item, bidCredits: last.bidCredits };
}
