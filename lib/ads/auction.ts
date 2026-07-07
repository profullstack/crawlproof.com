// Ad auction. v1 is a first-price auction: the highest bid (in credits) wins
// and is charged its bid; ties break randomly to spread delivery. This is
// intentionally a thin framework — the scoring step is the seam where future
// factors (CTR/quality score, pacing weight, second-price clearing, frequency
// capping) plug in without changing callers. It IS live today: serveAd runs
// every fill through runAuction.

export type BidCandidate<T> = {
  /** The campaign's bid, in credits. */
  bidCredits: number;
  item: T;
};

export type AuctionResult<T> = {
  winner: T;
  bidCredits: number;
} | null;

// Extend this to fold in quality/pacing later. Today score == bid.
function score(bidCredits: number): number {
  return bidCredits;
}

export function runAuction<T>(candidates: BidCandidate<T>[]): AuctionResult<T> {
  if (candidates.length === 0) return null;
  const scored = candidates.map((c) => ({ ...c, s: score(c.bidCredits) }));
  const top = Math.max(...scored.map((c) => c.s));
  const winners = scored.filter((c) => c.s === top);
  const win = winners[Math.floor(Math.random() * winners.length)];
  return { winner: win.item, bidCredits: win.bidCredits };
}
